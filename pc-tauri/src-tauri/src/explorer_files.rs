use std::{
    collections::HashMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    detached::DetachedWindows, send_to_shortcut, upload_stage::UploadStages, workspace,
    workspace_groups::WorkspaceGroups,
};

const MAX_FILES: usize = 10;
const MAX_HELD: usize = 40;
const KEEP_FOR: Duration = Duration::from_secs(30 * 60);
const EVENT: &str = "pulse-explorer-files";
const UNAVAILABLE: &str = "资源管理器附件已失效，请重新选择文件。";
const OPEN_FAILED: &str = "无法添加所选文件，请检查文件是否存在、大小是否超限。";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerAttachment {
    id: Uuid,
    name: String,
    size: u64,
    #[serde(rename = "type")]
    mime: &'static str,
}

struct Incoming {
    details: ExplorerAttachment,
    source: AsyncMutex<tokio::fs::File>,
    created: Instant,
}

struct Entry {
    incoming: Arc<Incoming>,
    owner: String,
    account: Option<(Uuid, CancellationToken)>,
    claimed: bool,
}

impl Entry {
    fn retained(&self) -> bool {
        self.incoming.created.elapsed() < KEEP_FOR
            && self
                .account
                .as_ref()
                .is_none_or(|(_, cancel)| !cancel.is_cancelled())
    }

    fn owned_by(&self, window: &WebviewWindow, user: Uuid) -> bool {
        self.owner == window.label()
            && self.retained()
            && self
                .account
                .as_ref()
                .is_none_or(|(owner, _)| *owner == user)
    }
}

#[derive(Default)]
pub struct ExplorerFiles(Mutex<HashMap<Uuid, Entry>>);

impl ExplorerFiles {
    pub fn close_window(&self, owner: &str) {
        if let Ok(mut items) = self.0.lock() {
            items.retain(|_, entry| entry.owner != owner);
        }
    }
}

pub fn supervise(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let state = app.state::<ExplorerFiles>();
            if let Ok(mut entries) = state.0.lock() {
                entries.retain(|_, entry| entry.retained());
            };
        }
    });
}

pub fn paths(args: impl IntoIterator<Item = OsString>) -> Option<Vec<PathBuf>> {
    let mut args = args.into_iter().skip(1);
    if args.next()?.as_os_str() != send_to_shortcut::ARGUMENT {
        return None;
    }
    Some(args.take(MAX_FILES).map(PathBuf::from).collect())
}

pub fn receive(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        workspace::show_main(app);
        return;
    }
    let Some(groups) = app.try_state::<WorkspaceGroups>() else {
        return;
    };
    let Some(window) = groups.recent_window(app) else {
        return;
    };
    workspace::show(&window);
    let app = app.clone();
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn(async move {
        let attempted = paths.len();
        let Ok(opened) = tauri::async_runtime::spawn_blocking(move || {
            paths.into_iter().filter_map(open_file).collect::<Vec<_>>()
        })
        .await
        else {
            return;
        };
        if app.get_webview_window(&owner).is_none() {
            return;
        }
        let state = app.state::<ExplorerFiles>();
        let added = {
            let Ok(mut entries) = state.0.lock() else {
                return;
            };
            entries.retain(|_, entry| entry.retained());
            let remaining = MAX_HELD.saturating_sub(entries.len());
            let added = remaining.min(opened.len());
            for incoming in opened.into_iter().take(added) {
                entries.insert(
                    incoming.details.id,
                    Entry {
                        incoming: Arc::new(incoming),
                        owner: owner.clone(),
                        account: None,
                        claimed: false,
                    },
                );
            }
            added
        };
        let warning = (added < attempted).then_some(OPEN_FAILED);
        let _ = app.emit_to(&owner, EVENT, warning);
    });
}

fn open_file(path: PathBuf) -> Option<Incoming> {
    if !is_disk_file(&path) {
        return None;
    }
    let file = open_read_handle(&path)?;
    let metadata = file.metadata().ok()?;
    let size = metadata.len();
    let (mime, limit) = media_type(&path);
    if !metadata.is_file() || size == 0 || size > limit * 1024 * 1024 {
        return None;
    }
    Some(Incoming {
        details: ExplorerAttachment {
            id: Uuid::new_v4(),
            name: path.file_name()?.to_string_lossy().into_owned(),
            size,
            mime,
        },
        source: AsyncMutex::new(tokio::fs::File::from_std(file)),
        created: Instant::now(),
    })
}

#[cfg(windows)]
fn open_read_handle(path: &Path) -> Option<fs::File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    (metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0).then_some(file)
}

#[cfg(not(windows))]
fn open_read_handle(_: &Path) -> Option<fs::File> {
    None
}

#[cfg(windows)]
fn is_disk_file(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    path.is_absolute()
        && matches!(path.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        && path.components().skip(1).all(|entry| match entry {
            Component::Normal(name) => !name.to_string_lossy().contains(':'),
            Component::RootDir => true,
            _ => false,
        })
}

#[cfg(not(windows))]
fn is_disk_file(_: &Path) -> bool {
    false
}

fn media_type(path: &Path) -> (&'static str, u64) {
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "jpg" | "jpeg" => ("image/jpeg", 10),
        "png" => ("image/png", 10),
        "gif" => ("image/gif", 10),
        "webp" => ("image/webp", 10),
        "mp4" | "m4v" => ("video/mp4", 100),
        "mov" => ("video/quicktime", 100),
        "webm" => ("video/webm", 100),
        "avi" => ("video/x-msvideo", 100),
        "mkv" => ("video/x-matroska", 100),
        "mp3" => ("audio/mpeg", 10),
        "m4a" => ("audio/mp4", 10),
        "wav" => ("audio/wav", 10),
        "ogg" | "opus" => ("audio/ogg", 10),
        _ => ("application/octet-stream", 50),
    }
}

#[tauri::command]
pub fn pending_explorer_files(
    window: WebviewWindow,
    files: State<'_, ExplorerFiles>,
    windows: State<'_, DetachedWindows>,
    lease: Uuid,
) -> Result<Vec<ExplorerAttachment>, &'static str> {
    let scope = windows.download_scope(&window, lease)?;
    let mut entries = files.0.lock().map_err(|_| UNAVAILABLE)?;
    entries.retain(|_, entry| entry.retained());
    let mut pending: Vec<_> = entries
        .values_mut()
        .filter(|entry| !entry.claimed && entry.owned_by(&window, scope.user))
        .collect();
    pending.sort_by_key(|entry| entry.incoming.created);
    Ok(pending
        .into_iter()
        .take(MAX_FILES)
        .map(|entry| {
            entry
                .account
                .get_or_insert_with(|| (scope.user, scope.cancel.clone()));
            entry.incoming.details.clone()
        })
        .collect())
}

#[tauri::command]
pub fn claim_explorer_files(
    window: WebviewWindow,
    files: State<'_, ExplorerFiles>,
    windows: State<'_, DetachedWindows>,
    lease: Uuid,
    ids: Vec<Uuid>,
) -> Result<Vec<ExplorerAttachment>, &'static str> {
    let scope = windows.download_scope(&window, lease)?;
    if ids.is_empty()
        || ids.len() > MAX_FILES
        || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
    {
        return Err(UNAVAILABLE);
    }
    let mut entries = files.0.lock().map_err(|_| UNAVAILABLE)?;
    if ids.iter().any(|id| {
        !entries.get(id).is_some_and(|entry| {
            entry.owned_by(&window, scope.user) && !entry.claimed && entry.account.is_some()
        })
    }) {
        return Err(UNAVAILABLE);
    }
    Ok(ids
        .into_iter()
        .filter_map(|id| {
            let entry = entries.get_mut(&id)?;
            entry.claimed = true;
            Some(entry.incoming.details.clone())
        })
        .collect())
}

#[tauri::command]
pub fn unclaim_explorer_files(
    window: WebviewWindow,
    files: State<'_, ExplorerFiles>,
    windows: State<'_, DetachedWindows>,
    lease: Uuid,
    ids: Vec<Uuid>,
) -> Result<(), &'static str> {
    let scope = windows.download_scope(&window, lease)?;
    if ids.len() > MAX_FILES {
        return Err(UNAVAILABLE);
    }
    let mut entries = files.0.lock().map_err(|_| UNAVAILABLE)?;
    for id in ids {
        if let Some(entry) = entries
            .get_mut(&id)
            .filter(|entry| entry.owned_by(&window, scope.user))
        {
            entry.claimed = false;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn discard_explorer_files(
    window: WebviewWindow,
    files: State<'_, ExplorerFiles>,
    windows: State<'_, DetachedWindows>,
    lease: Uuid,
    ids: Vec<Uuid>,
) -> Result<(), &'static str> {
    let scope = windows.download_scope(&window, lease)?;
    if ids.len() > MAX_FILES {
        return Err(UNAVAILABLE);
    }
    let mut entries = files.0.lock().map_err(|_| UNAVAILABLE)?;
    for id in ids {
        if entries
            .get(&id)
            .is_some_and(|entry| entry.owned_by(&window, scope.user))
        {
            entries.remove(&id);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_explorer_file(
    window: WebviewWindow,
    files: State<'_, ExplorerFiles>,
    windows: State<'_, DetachedWindows>,
    uploads: State<'_, UploadStages>,
    lease: Uuid,
    id: Uuid,
) -> Result<crate::upload_stage::ExplorerStage, &'static str> {
    let scope = windows.download_scope(&window, lease)?;
    let source = files
        .0
        .lock()
        .map_err(|_| UNAVAILABLE)?
        .get(&id)
        .filter(|entry| entry.owned_by(&window, scope.user) && entry.claimed)
        .map(|entry| entry.incoming.clone())
        .ok_or(UNAVAILABLE)?;
    let mut file = source.source.lock().await;
    if scope.cancel.is_cancelled() {
        return Err(UNAVAILABLE);
    }
    uploads
        .prepare_explorer(
            window.label(),
            &scope.token,
            source.details.size,
            &mut file,
            scope.cancel,
        )
        .await
}
