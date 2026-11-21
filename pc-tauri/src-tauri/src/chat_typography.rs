use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::workspace::{conversation_window, is_workspace, trusted_page};

const MAX_BYTES: u64 = 16 * 1024;
const SAVE_ERROR: &str = "无法保存本机聊天字体，请重试。";
const IMPORT_ERROR: &str = "无法读取字体设置，请选择旧版的 chat-typography.json 文件。";
const CHANGED: &str = "pulse-chat-typography";

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Family {
    #[default]
    Yahei,
    Song,
    Hei,
    Kai,
    System,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Serialize)]
pub struct Typography {
    size: u8,
    family: Family,
    bold: bool,
}

impl Default for Typography {
    fn default() -> Self {
        Self {
            size: 14,
            family: Family::default(),
            bold: false,
        }
    }
}

impl Typography {
    fn normalized(mut self) -> Self {
        self.size = self.size.clamp(12, 28);
        self
    }

    fn read(path: &Path) -> Result<Self, &'static str> {
        let file = File::open(path).map_err(|_| IMPORT_ERROR)?;
        let mut raw = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut raw)
            .map_err(|_| IMPORT_ERROR)?;
        if raw.len() as u64 > MAX_BYTES {
            return Err(IMPORT_ERROR);
        }
        let raw = raw.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&raw);
        serde_json::from_slice::<Self>(raw)
            .map(Self::normalized)
            .map_err(|_| IMPORT_ERROR)
    }
}

#[derive(Clone, Copy, Default, Serialize)]
pub struct TypographyState {
    revision: u64,
    value: Typography,
}

pub struct ChatTypography {
    path: PathBuf,
    state: Mutex<TypographyState>,
}

impl ChatTypography {
    pub fn load(app: &AppHandle) -> tauri::Result<Self> {
        let path = crate::storage::data(app)?.join("chat-typography.json");
        let value = Typography::read(&path).unwrap_or_default();
        Ok(Self {
            path,
            state: Mutex::new(TypographyState { revision: 0, value }),
        })
    }

    async fn save(
        &self,
        app: &AppHandle,
        value: Typography,
    ) -> Result<TypographyState, &'static str> {
        let mut current = self.state.lock().await;
        if current.value == value {
            return Ok(*current);
        }
        let dir = self.path.parent().ok_or(SAVE_ERROR)?;
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|_| SAVE_ERROR)?;
        let tmp = dir.join(format!("chat-typography-{}.tmp", Uuid::new_v4()));
        let raw = serde_json::to_vec(&value).map_err(|_| SAVE_ERROR)?;
        if tokio::fs::write(&tmp, raw).await.is_err()
            || tokio::fs::rename(&tmp, &self.path).await.is_err()
        {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(SAVE_ERROR);
        }
        current.revision += 1;
        current.value = value;
        for window in app.webview_windows().into_values() {
            if observes(window.label()) {
                let _ = app.emit_to(window.label(), CHANGED, *current);
            }
        }
        Ok(*current)
    }
}

fn observes(label: &str) -> bool {
    is_workspace(label) || conversation_window(label) || label.starts_with("history-")
}

fn verify_window(window: &WebviewWindow, can_write: bool) -> Result<(), &'static str> {
    let allowed = if can_write {
        is_workspace(window.label())
    } else {
        observes(window.label())
    };
    if allowed && window.url().is_ok_and(|url| trusted_page(&url)) {
        Ok(())
    } else {
        Err("此窗口无法操作聊天字体。")
    }
}

#[tauri::command]
pub async fn chat_typography(
    window: WebviewWindow,
    font: State<'_, ChatTypography>,
) -> Result<TypographyState, &'static str> {
    verify_window(&window, false)?;
    Ok(*font.state.lock().await)
}

#[tauri::command]
pub async fn set_chat_typography(
    app: AppHandle,
    window: WebviewWindow,
    font: State<'_, ChatTypography>,
    value: Typography,
) -> Result<TypographyState, &'static str> {
    verify_window(&window, true)?;
    font.save(&app, value.normalized()).await
}

#[tauri::command]
pub async fn import_chat_typography(
    app: AppHandle,
    window: WebviewWindow,
    font: State<'_, ChatTypography>,
) -> Result<Option<TypographyState>, &'static str> {
    verify_window(&window, true)?;
    let (ready, file) = oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("选择旧版聊天字体设置")
        .add_filter("字体设置", &["json"])
        .pick_file(move |selected| {
            let _ = ready.send(selected);
        });
    let Some(file) = file.await.map_err(|_| IMPORT_ERROR)? else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|_| IMPORT_ERROR)?;
    if path.file_name().and_then(|name| name.to_str()) != Some("chat-typography.json") {
        return Err(IMPORT_ERROR);
    }
    let value = tauri::async_runtime::spawn_blocking(move || Typography::read(&path))
        .await
        .map_err(|_| IMPORT_ERROR)??;
    verify_window(&window, true)?;
    font.save(&app, value).await.map(Some)
}
