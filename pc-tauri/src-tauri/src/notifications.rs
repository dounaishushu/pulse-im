use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::workspace::{is_workspace, show, trusted_page};

pub const LABEL: &str = "desktop-notice";
const LIFETIME: Duration = Duration::from_secs(8);
const WINDOW_START_TIMEOUT: Duration = Duration::from_secs(25);
const CHANGE_EVENT: &str = "pulse-desktop-notices";
const OPEN_EVENT: &str = "pulse-desktop-notice-click";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeInput {
    scope: Uuid,
    conversation_id: u64,
    title: String,
    body: String,
    silent: bool,
    limit: usize,
}

#[derive(Clone, Serialize)]
pub struct NoticeView {
    id: Uuid,
    title: String,
    body: String,
}

struct Notice {
    view: NoticeView,
    owner: String,
    scope: Uuid,
    conversation_id: u64,
    deadline: Option<Instant>,
}

#[derive(Default)]
struct Stack {
    notices: VecDeque<Notice>,
    retired: VecDeque<(String, Uuid)>,
    ready: bool,
    last_sound: Option<Instant>,
}

#[derive(Default)]
pub struct Notifications {
    stack: Mutex<Stack>,
    making_window: tokio::sync::Mutex<()>,
    next_deadline: Notify,
}

impl Notifications {
    pub fn close_workspace(&self, app: &AppHandle, label: &str) {
        if !is_workspace(label) {
            return;
        }
        if let Ok(mut stack) = self.stack.lock() {
            stack.notices.retain(|notice| notice.owner != label);
            stack.retired.retain(|(owner, _)| owner != label);
        }
        self.changed(app);
    }

    fn changed(&self, app: &AppHandle) {
        let Ok(stack) = self.stack.lock() else { return };
        let count = stack.notices.len();
        let ready = stack.ready;
        drop(stack);
        if let Some(window) = app.get_webview_window(LABEL) {
            if count == 0 {
                let _ = window.hide();
            } else if ready {
                position(&window, count);
                let _ = app.emit_to(LABEL, CHANGE_EVENT, ());
                let _ = window.show();
            }
        }
        self.next_deadline.notify_one();
    }
}

pub fn supervise(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Notifications>();
        loop {
            let deadline = state.stack.lock().ok().and_then(|stack| {
                stack
                    .notices
                    .iter()
                    .filter_map(|notice| notice.deadline)
                    .min()
            });
            let Some(deadline) = deadline else {
                state.next_deadline.notified().await;
                continue;
            };
            tokio::select! {
                _ = tokio::time::sleep_until(deadline.into()) => {
                    if let Ok(mut stack) = state.stack.lock() {
                        stack.notices.retain(|notice| notice.deadline.is_none_or(|deadline| deadline > Instant::now()));
                    }
                    state.changed(&app);
                }
                _ = state.next_deadline.notified() => {}
            }
        }
    });
}

fn workspace_only(window: &WebviewWindow) -> Result<(), &'static str> {
    if is_workspace(window.label()) && window.url().is_ok_and(|url| trusted_page(&url)) {
        Ok(())
    } else {
        Err("invalid_notification_window")
    }
}

fn notice_window_only(window: &WebviewWindow) -> Result<(), &'static str> {
    if window.label() == LABEL {
        Ok(())
    } else {
        Err("invalid_notification_window")
    }
}

async fn make_window(app: &AppHandle, state: &Notifications) -> Result<(), &'static str> {
    let _once = state.making_window.lock().await;
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    if let Ok(mut stack) = state.stack.lock() {
        stack.ready = false;
    }
    let data_dir = crate::storage::cache(app)
        .map_err(|_| "notice_cache_unavailable")?
        .join("notice-webview");
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .use_https_scheme(true)
        .title("新消息")
        .inner_size(360.0, 94.0)
        .visible(false)
        .focused(false)
        .focusable(false)
        .resizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .disable_drag_drop_handler()
        .data_directory(data_dir)
        .on_navigation(trusted_page)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|_| "notice_window_unavailable")?;
    Ok(())
}

fn position(window: &WebviewWindow, count: usize) {
    let main_monitor = window
        .app_handle()
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten());
    let Some(monitor) = main_monitor.or_else(|| window.primary_monitor().ok().flatten()) else {
        return;
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let width = (360.0 * scale).round() as u32;
    let height = ((count as f64 * 94.0) * scale).round() as u32;
    let padding = (12.0 * scale).round() as i32;
    let right = work.position.x + work.size.width as i32;
    let bottom = work.position.y + work.size.height as i32;
    let _ = window.set_size(PhysicalSize::new(width, height));
    let _ = window.set_position(PhysicalPosition::new(
        right - width as i32 - padding,
        bottom - height as i32 - padding,
    ));
}

#[tauri::command]
pub async fn show_desktop_notice(
    window: WebviewWindow,
    app: AppHandle,
    notices: State<'_, Notifications>,
    input: NoticeInput,
) -> Result<(), &'static str> {
    workspace_only(&window)?;
    if input.conversation_id == 0 || input.conversation_id > 9_007_199_254_740_991 {
        return Err("invalid_notification_target");
    }
    let owner = (window.label().to_owned(), input.scope);
    let play_sound = {
        let mut stack = notices.stack.lock().map_err(|_| "notice_unavailable")?;
        if stack.retired.contains(&owner) {
            return Ok(());
        }
        let previous = stack
            .notices
            .iter()
            .position(|notice| {
                notice.owner == owner.0
                    && notice.scope == input.scope
                    && notice.conversation_id == input.conversation_id
            })
            .and_then(|index| stack.notices.remove(index));
        let previous_id = previous
            .map(|notice| notice.view.id)
            .unwrap_or_else(Uuid::new_v4);
        let title: String = input.title.chars().take(80).collect();
        let body: String = input.body.chars().take(300).collect();
        let lifetime = if stack.ready {
            LIFETIME
        } else {
            WINDOW_START_TIMEOUT
        };
        stack.notices.push_back(Notice {
            view: NoticeView {
                id: previous_id,
                title,
                body,
            },
            owner: owner.0.clone(),
            scope: input.scope,
            conversation_id: input.conversation_id,
            deadline: Some(Instant::now() + lifetime),
        });
        let limit = input.limit.clamp(1, 5);
        while stack.notices.len() > limit {
            stack.notices.pop_front();
        }
        let play = !input.silent
            && stack
                .last_sound
                .is_none_or(|last| last.elapsed() >= Duration::from_millis(1500));
        if play {
            stack.last_sound = Some(Instant::now());
        }
        play
    };
    make_window(&app, &notices).await?;
    notices.changed(&app);
    if play_sound
        && notices
            .stack
            .lock()
            .ok()
            .is_some_and(|stack| !stack.retired.contains(&owner))
    {
        beep();
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_notices_snapshot(
    window: WebviewWindow,
    notices: State<'_, Notifications>,
) -> Result<Vec<NoticeView>, &'static str> {
    notice_window_only(&window)?;
    let stack = notices.stack.lock().map_err(|_| "notice_unavailable")?;
    Ok(stack
        .notices
        .iter()
        .map(|notice| notice.view.clone())
        .collect())
}

#[tauri::command]
pub fn desktop_notices_ready(
    window: WebviewWindow,
    app: AppHandle,
    notices: State<'_, Notifications>,
) -> Result<(), &'static str> {
    notice_window_only(&window)?;
    {
        let mut stack = notices.stack.lock().map_err(|_| "notice_unavailable")?;
        if !stack.ready {
            stack.ready = true;
            let now = Instant::now();
            stack
                .notices
                .retain(|notice| notice.deadline.is_none_or(|time| time > now));
            let deadline = now + LIFETIME;
            for notice in &mut stack.notices {
                notice.deadline = Some(deadline);
            }
        }
    }
    notices.changed(&app);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeAction {
    Open,
    Reply,
    Close,
    Hover,
    Leave,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenNotice {
    scope: Uuid,
    conversation_id: u64,
    reply: bool,
}

#[tauri::command]
pub fn desktop_notice_action(
    window: WebviewWindow,
    app: AppHandle,
    notices: State<'_, Notifications>,
    id: Uuid,
    action: NoticeAction,
) -> Result<(), &'static str> {
    notice_window_only(&window)?;
    let action_target = {
        let mut stack = notices.stack.lock().map_err(|_| "notice_unavailable")?;
        let Some(index) = stack.notices.iter().position(|notice| notice.view.id == id) else {
            return Ok(());
        };
        let notice = &mut stack.notices[index];
        match action {
            NoticeAction::Hover => {
                notice.deadline = None;
                notices.next_deadline.notify_one();
                return Ok(());
            }
            NoticeAction::Leave => {
                notice.deadline = Some(Instant::now() + LIFETIME);
                notices.next_deadline.notify_one();
                return Ok(());
            }
            _ => {}
        }
        let notice = stack.notices.remove(index).expect("notification index");
        (!matches!(action, NoticeAction::Close)).then_some((
            notice.owner,
            OpenNotice {
                scope: notice.scope,
                conversation_id: notice.conversation_id,
                reply: matches!(action, NoticeAction::Reply),
            },
        ))
    };
    notices.changed(&app);
    if let Some((owner, event)) = action_target {
        if let Some(view) = app.get_webview_window(&owner) {
            show(&view);
            let _ = app.emit_to(owner, OPEN_EVENT, event);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn clear_desktop_notices(
    window: WebviewWindow,
    app: AppHandle,
    notices: State<'_, Notifications>,
    scope: Uuid,
) -> Result<(), &'static str> {
    workspace_only(&window)?;
    {
        let mut stack = notices.stack.lock().map_err(|_| "notice_unavailable")?;
        let owner = window.label().to_owned();
        stack
            .notices
            .retain(|notice| notice.owner != owner || notice.scope != scope);
        let target = (owner, scope);
        if !stack.retired.contains(&target) {
            stack.retired.push_back(target);
            if stack.retired.len() > 256 {
                stack.retired.pop_front();
            }
        }
    }
    notices.changed(&app);
    Ok(())
}

#[cfg(target_os = "windows")]
fn beep() {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBeep(kind: u32) -> i32;
    }
    unsafe {
        MessageBeep(0);
    }
}

#[cfg(not(target_os = "windows"))]
fn beep() {}
