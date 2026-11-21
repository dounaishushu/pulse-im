use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Visibility {
    tray: bool,
    taskbar: bool,
}

impl Default for Visibility {
    fn default() -> Self {
        Self {
            tray: true,
            taskbar: true,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemOptions {
    tray: bool,
    taskbar: bool,
    auto_launch: Option<bool>,
    send_to: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemKey {
    Tray,
    Taskbar,
    AutoLaunch,
    SendTo,
}

pub struct SystemSettings {
    path: PathBuf,
    visibility: Mutex<Visibility>,
    visible_tray: AtomicBool,
}

impl SystemSettings {
    pub fn load(app: &AppHandle) -> tauri::Result<Self> {
        let path = crate::storage::data(app)?.join("desktop-settings-v1.json");
        let value = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Visibility>(&bytes).ok())
            .unwrap_or_default();
        Ok(Self {
            path,
            visibility: Mutex::new(value),
            visible_tray: AtomicBool::new(value.tray),
        })
    }

    pub fn close_to_tray(&self) -> bool {
        self.visible_tray.load(Ordering::Acquire)
    }

    pub async fn skip_taskbar(&self) -> bool {
        !self.visibility.lock().await.taskbar
    }

    pub fn apply_initial(&self, app: &AppHandle) -> Result<(), &'static str> {
        let current = self
            .visibility
            .try_lock()
            .map_err(|_| "无法读取系统设置。")?;
        apply_visibility(app, *current)
    }

    async fn store(&self, next: Visibility) -> Result<(), &'static str> {
        let parent = self.path.parent().ok_or("无法保存系统设置。")?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| "无法保存系统设置。")?;
        let temp = parent.join(format!("desktop-settings-{}.tmp", Uuid::new_v4()));
        let content = serde_json::to_vec(&next).map_err(|_| "无法保存系统设置。")?;
        if tokio::fs::write(&temp, content).await.is_err()
            || tokio::fs::rename(&temp, &self.path).await.is_err()
        {
            let _ = tokio::fs::remove_file(temp).await;
            return Err("无法保存系统设置。");
        }
        Ok(())
    }
}

fn apply_visibility(app: &AppHandle, value: Visibility) -> Result<(), &'static str> {
    let tray = app.tray_by_id("workspace").ok_or("无法操作托盘图标。")?;
    if value.tray {
        tray.set_visible(true).map_err(|_| "无法显示托盘图标。")?;
    }
    for window in app
        .webview_windows()
        .values()
        .filter(|view| crate::workspace::is_workspace(view.label()))
    {
        window
            .set_skip_taskbar(!value.taskbar)
            .map_err(|_| "无法操作任务栏图标。")?;
    }
    if !value.tray {
        tray.set_visible(false).map_err(|_| "无法隐藏托盘图标。")?;
    }
    Ok(())
}

async fn read_options(app: AppHandle, visible: Visibility) -> SystemOptions {
    if cfg!(feature = "portable") {
        return SystemOptions {
            tray: visible.tray,
            taskbar: visible.taskbar,
            auto_launch: None,
            send_to: None,
        };
    }
    let auto_launch = tauri::async_runtime::spawn_blocking(startup::enabled);
    let send_to =
        tauri::async_runtime::spawn_blocking(move || crate::send_to_shortcut::enabled(&app));
    SystemOptions {
        tray: visible.tray,
        taskbar: visible.taskbar,
        auto_launch: auto_launch.await.ok().and_then(Result::ok),
        send_to: send_to.await.ok().and_then(Result::ok),
    }
}

#[tauri::command]
pub async fn open_system_sound_settings(window: tauri::WebviewWindow) -> Result<(), &'static str> {
    if !crate::workspace::is_workspace(window.label())
        || !window
            .url()
            .is_ok_and(|url| crate::workspace::trusted_page(&url))
    {
        return Err("无法从当前窗口打开系统设置。");
    }
    tauri::async_runtime::spawn_blocking(launch_sound_settings)
        .await
        .map_err(|_| "无法打开 Windows 声音设置。")?
}

fn launch_sound_settings() -> Result<(), &'static str> {
    crate::windows_shell::open(std::ffi::OsStr::new("ms-settings:sound"))
        .then_some(())
        .ok_or("无法打开 Windows 声音设置。")
}

#[tauri::command]
pub async fn desktop_system_options(
    app: AppHandle,
    settings: State<'_, SystemSettings>,
) -> Result<SystemOptions, &'static str> {
    let visible = *settings.visibility.lock().await;
    Ok(read_options(app, visible).await)
}

#[tauri::command]
pub async fn set_desktop_system_option(
    app: AppHandle,
    settings: State<'_, SystemSettings>,
    key: SystemKey,
    enabled: bool,
) -> Result<SystemOptions, &'static str> {
    if cfg!(feature = "portable") && matches!(key, SystemKey::AutoLaunch | SystemKey::SendTo) {
        return Err("便携版不写入 Windows 开机启动和发送到菜单。");
    }
    let mut current = settings.visibility.lock().await;
    let old = *current;
    let mut next = old;
    match key {
        SystemKey::Tray => next.tray = enabled,
        SystemKey::Taskbar => next.taskbar = enabled,
        SystemKey::AutoLaunch => {
            tauri::async_runtime::spawn_blocking(move || startup::set_enabled(enabled))
                .await
                .map_err(|_| "无法修改开机启动设置。")?
                .map_err(|_| "无法修改开机启动设置。")?;
            return Ok(read_options(app, old).await);
        }
        SystemKey::SendTo => {
            let shell = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::send_to_shortcut::set(&shell, enabled)
            })
            .await
            .map_err(|_| "无法修改发送到菜单。")??;
            return Ok(read_options(app, old).await);
        }
    }
    if let Err(error) = apply_visibility(&app, next) {
        let _ = apply_visibility(&app, old);
        return Err(error);
    }
    if let Err(error) = settings.store(next).await {
        let _ = apply_visibility(&app, old);
        return Err(error);
    }
    settings.visible_tray.store(next.tray, Ordering::Release);
    *current = next;
    Ok(read_options(app, next).await)
}

#[cfg(target_os = "windows")]
mod startup {
    use std::io;
    use windows_registry::{Type, CURRENT_USER};
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};

    #[cfg(debug_assertions)]
    const NAME: &str = "Pulse IM 预览";
    #[cfg(not(debug_assertions))]
    const NAME: &str = "Pulse IM (Tauri)";
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    fn optional<T>(value: windows_registry::Result<T>) -> io::Result<Option<T>> {
        match value {
            Ok(value) => Ok(Some(value)),
            Err(error) => {
                let code = error.code().0 as u32;
                // Registry errors are HRESULTs. Reconstruct the Win32 status before
                // interpreting a missing Run entry as a disabled setting.
                let io_error = if code & 0xffff_0000 == 0x8007_0000 {
                    let status = code & 0xffff;
                    if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
                        return Ok(None);
                    }
                    io::Error::from_raw_os_error(status as i32)
                } else {
                    io::Error::from(error)
                };
                Err(io_error)
            }
        }
    }

    pub fn enabled() -> io::Result<bool> {
        let entry = optional(CURRENT_USER.open(RUN).and_then(|key| key.get_string(NAME)))?;
        if entry.is_none() {
            return Ok(false);
        }
        let state = optional(
            CURRENT_USER
                .open(APPROVED)
                .and_then(|key| key.get_value(NAME)),
        )?;
        Ok(state.is_none_or(|bytes| {
            bytes.len() < 8 || bytes.iter().rev().take(8).all(|value| *value == 0)
        }))
    }

    pub fn set_enabled(enabled: bool) -> io::Result<()> {
        if !enabled {
            let key = CURRENT_USER.options().write().open(RUN);
            optional(key.and_then(|key| key.remove_value(NAME)))?;
            return Ok(());
        }

        let current_exe = std::env::current_exe()?;
        let value = format!("\"{}\" --startup", current_exe.display());
        let key = CURRENT_USER.create(RUN).map_err(io::Error::from)?;
        let previous = optional(key.get_string(NAME))?;
        key.set_string(NAME, &value).map_err(io::Error::from)?;

        let approval = CURRENT_USER
            .options()
            .write()
            .open(APPROVED)
            .and_then(|key| {
                key.set_bytes(NAME, Type::Bytes, &[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
            });
        if let Err(error) = optional(approval) {
            if let Some(previous) = previous {
                let _ = key.set_string(NAME, &previous);
            } else {
                let _ = key.remove_value(NAME);
            }
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
mod startup {
    pub fn enabled() -> std::io::Result<bool> {
        Ok(false)
    }
    pub fn set_enabled(_enabled: bool) -> std::io::Result<()> {
        Err(std::io::ErrorKind::Unsupported.into())
    }
}
