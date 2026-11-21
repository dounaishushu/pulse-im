use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tauri::{
    ipc::Response, AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    detached::DetachedWindows,
    screen_pixels::{Frame, Screen, Selection},
    workspace::{show, trusted_page},
};

const INACTIVE: &str = "截图会话已关闭。";
const BUSY: &str = "正在截图，请先完成或取消。";
const LOAD_ERROR: &str = "无法打开截图窗口，请重试。";

struct ImageData {
    screen: Screen,
    frame: Frame,
    preview: Vec<u8>,
}

enum Phase {
    Reserved,
    Selecting(oneshot::Sender<Vec<u8>>),
    Finished,
}

struct Job {
    id: Uuid,
    owner: String,
    started_at: Instant,
    cancel: CancellationToken,
    authority: CancellationToken,
    phase: Mutex<Phase>,
    image: Mutex<Option<Arc<ImageData>>>,
    cropping: tokio::sync::Mutex<()>,
}

impl Job {
    fn overlay(&self) -> String {
        format!("screenshot-{}", self.id)
    }
    fn active(&self) -> bool {
        !self.cancel.is_cancelled() && !self.authority.is_cancelled()
    }
}

#[derive(Default)]
pub struct ScreenCapture(Mutex<Option<Arc<Job>>>);

impl ScreenCapture {
    pub fn cancel_window(&self, label: &str) {
        if let Ok(slot) = self.0.lock() {
            if let Some(job) = slot
                .as_ref()
                .filter(|job| job.owner == label || job.overlay() == label)
            {
                job.cancel.cancel();
            }
        }
    }

    fn get(&self, valid: impl Fn(&Job) -> bool) -> Result<Arc<Job>, &'static str> {
        self.0
            .lock()
            .map_err(|_| INACTIVE)?
            .as_ref()
            .filter(|job| job.active() && valid(job))
            .cloned()
            .ok_or(INACTIVE)
    }

    fn overlay(&self, window: &WebviewWindow) -> Result<Arc<Job>, &'static str> {
        if !window.url().is_ok_and(|url| trusted_page(&url)) {
            return Err(INACTIVE);
        }
        self.get(|job| job.overlay() == window.label())
    }

    fn finish(&self, app: &AppHandle, job: &Job, owner: &WebviewWindow, restore: bool) {
        if let Some(overlay) = app.get_webview_window(&job.overlay()) {
            let _ = overlay.destroy();
        }
        if restore && app.get_webview_window(&job.owner).is_some() {
            if job.authority.is_cancelled() {
                let _ = owner.show();
            } else {
                show(owner);
            }
        }
        if let Ok(mut slot) = self.0.lock() {
            if slot.as_ref().is_some_and(|active| active.id == job.id) {
                *slot = None;
            }
        }
    }
}

#[tauri::command]
pub fn begin_screen_capture(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    state: State<'_, ScreenCapture>,
) -> Result<Uuid, &'static str> {
    let authority = windows.screen_capture_authority(&window)?;
    let mut slot = state.0.lock().map_err(|_| BUSY)?;
    if let Some(previous) = slot.as_ref() {
        let reserved = matches!(*previous.phase.lock().map_err(|_| BUSY)?, Phase::Reserved);
        if !reserved
            || (previous.active() && previous.started_at.elapsed() < Duration::from_secs(10))
        {
            return Err(BUSY);
        }
    }
    let id = Uuid::new_v4();
    *slot = Some(Arc::new(Job {
        id,
        owner: window.label().to_owned(),
        started_at: Instant::now(),
        cancel: CancellationToken::new(),
        authority,
        phase: Mutex::new(Phase::Reserved),
        image: Mutex::new(None),
        cropping: tokio::sync::Mutex::new(()),
    }));
    Ok(id)
}

async fn prepare(app: &AppHandle, owner: &WebviewWindow, job: &Job) -> Result<(), &'static str> {
    let monitor = owner
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| owner.primary_monitor().ok().flatten())
        .ok_or("未找到可用的显示器。")?;
    let screen = Screen {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    };
    let scale = monitor.scale_factor();
    tokio::time::sleep(Duration::from_millis(180)).await;
    if !job.active() {
        return Err(INACTIVE);
    }
    let data = tauri::async_runtime::spawn_blocking(move || {
        let frame = Frame::capture(screen)?;
        let preview = frame.preview()?;
        Ok::<_, &'static str>(Arc::new(ImageData {
            screen,
            frame,
            preview,
        }))
    })
    .await
    .map_err(|_| LOAD_ERROR)??;
    if !job.active() {
        return Err(INACTIVE);
    }
    *job.image.lock().map_err(|_| LOAD_ERROR)? = Some(data);
    let folder = crate::storage::cache(&app)
        .map_err(|_| LOAD_ERROR)?
        .join("screenshot-webview");
    let overlay =
        WebviewWindowBuilder::new(app, job.overlay(), WebviewUrl::App("index.html".into()))
            .use_https_scheme(true)
            .title("截图")
            .inner_size(
                f64::from(screen.width) / scale,
                f64::from(screen.height) / scale,
            )
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .resizable(false)
            .disable_drag_drop_handler()
            .data_directory(folder)
            .on_navigation(trusted_page)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()
            .map_err(|_| LOAD_ERROR)?;
    overlay
        .set_position(PhysicalPosition::new(screen.x, screen.y))
        .map_err(|_| LOAD_ERROR)?;
    overlay
        .set_size(PhysicalSize::new(screen.width, screen.height))
        .map_err(|_| LOAD_ERROR)?;
    // Windows retains invisible resize borders on ordinary undecorated windows.
    // Borderless fullscreen on the selected monitor makes the preview cover its pixels exactly.
    overlay.set_fullscreen(true).map_err(|_| LOAD_ERROR)?;
    if !job.active() {
        return Err(INACTIVE);
    }
    overlay.show().map_err(|_| LOAD_ERROR)?;
    let _ = overlay.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn take_screen_capture(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ScreenCapture>,
    id: Uuid,
) -> Result<Response, &'static str> {
    let job = state.get(|job| job.id == id && job.owner == window.label())?;
    let (done, result) = oneshot::channel();
    {
        let mut phase = job.phase.lock().map_err(|_| BUSY)?;
        if !matches!(*phase, Phase::Reserved) || !job.active() {
            return Err(BUSY);
        }
        *phase = Phase::Selecting(done);
    }
    let restore = window.is_visible().unwrap_or(false);
    let captured = async {
        if restore {
            window.hide().map_err(|_| LOAD_ERROR)?;
        }
        prepare(&app, &window, &job).await?;
        tokio::select! {
            biased;
            _ = job.authority.cancelled() => Ok(Vec::new()),
            _ = job.cancel.cancelled() => Ok(Vec::new()),
            outcome = tokio::time::timeout(Duration::from_secs(300), result) => {
                Ok(outcome.ok().and_then(Result::ok).unwrap_or_default())
            }
        }
    }
    .await;
    state.finish(&app, &job, &window, restore);
    captured.map(Response::new)
}

#[tauri::command]
pub fn screen_capture_preview(
    window: WebviewWindow,
    state: State<'_, ScreenCapture>,
) -> Result<Response, &'static str> {
    let job = state.overlay(&window)?;
    let image = job
        .image
        .lock()
        .map_err(|_| INACTIVE)?
        .clone()
        .ok_or(INACTIVE)?;
    // Pack the original monitor size with the reduced preview to avoid sending a second IPC request.
    let mut bytes = Vec::with_capacity(8 + image.preview.len());
    bytes.extend_from_slice(&image.screen.width.to_le_bytes());
    bytes.extend_from_slice(&image.screen.height.to_le_bytes());
    bytes.extend_from_slice(&image.preview);
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn complete_screen_capture(
    window: WebviewWindow,
    state: State<'_, ScreenCapture>,
    selection: Selection,
) -> Result<(), &'static str> {
    let job = state.overlay(&window)?;
    let _cropping = job
        .cropping
        .try_lock()
        .map_err(|_| "正在处理截图，请稍候。")?;
    let image = job
        .image
        .lock()
        .map_err(|_| INACTIVE)?
        .clone()
        .ok_or(INACTIVE)?;
    let png = tauri::async_runtime::spawn_blocking(move || image.frame.crop_png(selection))
        .await
        .map_err(|_| "无法保存选区，请重试。")??;
    if !job.active() {
        return Err(INACTIVE);
    }
    let Phase::Selecting(done) = std::mem::replace(
        &mut *job.phase.lock().map_err(|_| INACTIVE)?,
        Phase::Finished,
    ) else {
        return Err(INACTIVE);
    };
    done.send(png).map_err(|_| INACTIVE)
}

#[tauri::command]
pub fn cancel_screen_capture(
    window: WebviewWindow,
    state: State<'_, ScreenCapture>,
    id: Option<Uuid>,
) -> Result<(), &'static str> {
    let job = state.get(|job| match id {
        Some(id) => job.id == id && job.owner == window.label(),
        None => job.overlay() == window.label(),
    })?;
    job.cancel.cancel();
    Ok(())
}
