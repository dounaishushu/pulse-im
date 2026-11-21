use std::{
    collections::HashMap,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::{fs, io::AsyncWriteExt, sync::Semaphore, time::timeout};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::http::{valid_authorization, ApiTransport};
use crate::{backend::Backend, detached::DetachedWindows};

const QUEUE_LIMIT: usize = 32;
const HISTORY_LIMIT: usize = 12;
const DOWNLOAD_QUEUE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;

#[derive(Clone, Eq, PartialEq)]
struct Owner {
    window: String,
    session: [u8; 32],
}

impl Owner {
    fn new(window: &WebviewWindow, token: &str) -> Result<Self, &'static str> {
        if !valid_authorization(&format!("Bearer {token}")) {
            return Err("请重新登录后下载。");
        }
        Ok(Self {
            window: window.label().to_owned(),
            session: Sha256::digest(token.as_bytes()).into(),
        })
    }
}

#[derive(Clone, Copy, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Status {
    Queued,
    Running,
    Saved,
    Failed,
    Cancelled,
}

impl Status {
    fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    id: String,
    name: String,
    status: Status,
    received: u64,
    total: Option<u64>,
    error: Option<&'static str>,
    saved_path: Option<String>,
}

struct Entry {
    owner: Owner,
    media_id: Uuid,
    directory: PathBuf,
    sequence: u64,
    task: Task,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Queue {
    items: HashMap<Uuid, Entry>,
    sequence: u64,
}

#[derive(Clone)]
pub struct Downloads(Arc<DownloadState>);

struct DownloadState {
    queue: Mutex<Queue>,
    default_directory: PathBuf,
    settings_dir: PathBuf,
    settings_write: Mutex<()>,
    slots: Semaphore,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPreferences {
    pub(crate) directory: PathBuf,
    ask_before_download: bool,
}

impl Downloads {
    pub fn new(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let data_dir = crate::storage::data(app)?;
        // Retain the directory selected in earlier Tauri previews as a fallback.
        let default_directory = std::fs::read(data_dir.join("download-directory.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PathBuf>(&bytes).ok())
            .filter(|path| path.is_absolute() && path.parent().is_some())
            .or_else(|| crate::storage::downloads(app).ok())
            .ok_or("missing Windows downloads directory")?;
        Ok(Self(Arc::new(DownloadState {
            queue: Mutex::new(Queue::default()),
            default_directory,
            settings_dir: data_dir.join("download-preferences"),
            settings_write: Mutex::new(()),
            slots: Semaphore::new(2),
        })))
    }

    pub fn close_window(&self, label: &str) {
        if let Ok(mut queue) = self.0.queue.lock() {
            queue.items.retain(|_, entry| {
                if entry.owner.window != label {
                    return true;
                }
                entry.cancel.cancel();
                false
            });
        }
    }

    fn preference_path(&self, owner: &str, user: Uuid) -> PathBuf {
        self.0.settings_dir.join(owner).join(format!("{user}.json"))
    }

    fn decode_preferences(&self, bytes: &[u8]) -> DownloadPreferences {
        serde_json::from_slice::<DownloadPreferences>(bytes)
            .ok()
            .filter(|prefs| prefs.directory.is_absolute() && prefs.directory.parent().is_some())
            .unwrap_or_else(|| DownloadPreferences {
                directory: self.0.default_directory.clone(),
                ask_before_download: true,
            })
    }

    pub(crate) async fn preferences(&self, owner: &str, user: Uuid) -> DownloadPreferences {
        let bytes = fs::read(self.preference_path(owner, user))
            .await
            .unwrap_or_default();
        self.decode_preferences(&bytes)
    }

    async fn save_preferences(
        &self,
        owner: String,
        user: Uuid,
        authority: CancellationToken,
        change: impl FnOnce(&mut DownloadPreferences) + Send + 'static,
    ) -> Result<DownloadPreferences, &'static str> {
        let state = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            const SAVE_ERROR: &str = "无法保存下载设置。";
            const ACCOUNT_CHANGED: &str = "当前账号已切换或锁定。";
            let _write = state.0.settings_write.lock().map_err(|_| SAVE_ERROR)?;
            if authority.is_cancelled() {
                return Err(ACCOUNT_CHANGED);
            }
            let config = state.preference_path(&owner, user);
            let mut next = state.decode_preferences(&std::fs::read(&config).unwrap_or_default());
            change(&mut next);
            std::fs::create_dir_all(config.parent().ok_or(SAVE_ERROR)?).map_err(|_| SAVE_ERROR)?;
            let bytes = serde_json::to_vec(&next).map_err(|_| SAVE_ERROR)?;
            let temp = config.with_extension(format!("{}.tmp", Uuid::new_v4()));
            let result = (|| {
                std::fs::write(&temp, bytes).map_err(|_| SAVE_ERROR)?;
                if authority.is_cancelled() {
                    return Err(ACCOUNT_CHANGED);
                }
                std::fs::rename(&temp, &config).map_err(|_| SAVE_ERROR)
            })();
            if result.is_err() {
                let _ = std::fs::remove_file(&temp);
            }
            result.map(|()| next)
        })
        .await
        .map_err(|_| "无法保存下载设置。")?
    }

    fn update(&self, id: Uuid, update: impl FnOnce(&mut Task)) {
        if let Ok(mut queue) = self.0.queue.lock() {
            if let Some(entry) = queue.items.get_mut(&id) {
                update(&mut entry.task);
            }
        }
    }

    fn finish(&self, id: Uuid, owner: &Owner, result: Result<PathBuf, &'static str>) {
        self.update(id, |task| match result {
            Ok(path) => {
                task.status = Status::Saved;
                task.saved_path = Some(path.to_string_lossy().into_owned());
            }
            Err(message) => {
                task.status = if message == "下载已取消。" {
                    Status::Cancelled
                } else {
                    Status::Failed
                };
                task.error = Some(message);
            }
        });
        if let Ok(mut queue) = self.0.queue.lock() {
            let mut history: Vec<_> = queue
                .items
                .iter()
                .filter(|(_, entry)| &entry.owner == owner && !entry.task.status.active())
                .map(|(id, entry)| (*id, entry.sequence))
                .collect();
            history.sort_unstable_by_key(|(_, sequence)| std::cmp::Reverse(*sequence));
            for (id, _) in history.into_iter().skip(HISTORY_LIMIT) {
                queue.items.remove(&id);
            }
        }
    }
}

#[tauri::command]
pub async fn download_preferences(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    downloads: State<'_, Downloads>,
    lease: Uuid,
) -> Result<DownloadPreferences, &'static str> {
    let scope = windows.download_scope(&window, lease)?;
    let preferences = downloads.preferences(&scope.owner, scope.user).await;
    windows.download_scope(&window, lease)?;
    Ok(preferences)
}

pub(crate) async fn pick_directory(
    app: AppHandle,
    window: WebviewWindow,
    current: PathBuf,
) -> Result<Option<PathBuf>, &'static str> {
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_title("选择下载目录")
            .set_directory(current)
            .set_parent(&window)
            .blocking_pick_folder();
        let Some(selected) = selection else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| "请选择本机目录。")?;
        if !path.is_absolute() || path.parent().is_none() || !path.is_dir() {
            return Err("请选择有效的下载目录。");
        }
        Ok(Some(path))
    })
    .await
    .map_err(|_| "无法选择下载目录。")?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDownloadPreferences {
    directory: Option<PathBuf>,
    ask_before_download: Option<bool>,
}

#[tauri::command]
pub async fn choose_download_directory(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    downloads: State<'_, Downloads>,
    lease: Uuid,
    legacy: Option<LegacyDownloadPreferences>,
) -> Result<Option<DownloadPreferences>, &'static str> {
    let scope = windows.download_scope(&window, lease)?;
    let prefs = downloads.preferences(&scope.owner, scope.user).await;
    let hinted_path = legacy.as_ref().and_then(|value| value.directory.as_ref());
    let directory = if let Some(path) = hinted_path.filter(|path| {
        use std::path::{Component, Prefix};
        matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
            && path.is_absolute()
            && path.parent().is_some()
            && !path.components().any(|c| c == Component::ParentDir)
    }) {
        match fs::metadata(path).await {
            Ok(meta) if meta.is_dir() => path.clone(),
            _ => prefs.directory,
        }
    } else {
        prefs.directory
    };
    windows.download_scope(&window, lease)?;
    let Some(path) = pick_directory(app, window.clone(), directory).await? else {
        return Ok(None);
    };
    let scope = windows.download_scope(&window, lease)?;
    downloads
        .save_preferences(scope.owner, scope.user, scope.cancel, |prefs| {
            prefs.directory = path;
            if let Some(ask) = legacy.and_then(|value| value.ask_before_download) {
                prefs.ask_before_download = ask;
            }
        })
        .await
        .map(Some)
}

#[tauri::command]
pub async fn set_download_prompt(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    downloads: State<'_, Downloads>,
    lease: Uuid,
    enabled: bool,
) -> Result<DownloadPreferences, &'static str> {
    let scope = windows.download_scope(&window, lease)?;
    downloads
        .save_preferences(scope.owner, scope.user, scope.cancel, move |prefs| {
            prefs.ask_before_download = enabled;
        })
        .await
}

pub(crate) struct DownloadSpec {
    pub(crate) media_id: Uuid,
    pub(crate) name: String,
    pub(crate) token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInput {
    media_id: Uuid,
    name: String,
}

struct Job {
    id: Uuid,
    client: Client,
    grant_url: Url,
    name: String,
    directory: PathBuf,
    token: String,
    cancel: CancellationToken,
}

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    backend: State<'_, Backend>,
    downloads: State<'_, Downloads>,
    api: State<'_, ApiTransport>,
    lease: Uuid,
    input: DownloadInput,
) -> Result<Option<String>, &'static str> {
    let scope = windows.download_scope(&window, lease)?;
    let prefs = downloads.preferences(&scope.owner, scope.user).await;
    let directory = if prefs.ask_before_download {
        windows.download_scope(&window, lease)?;
        let Some(path) = pick_directory(app.clone(), window.clone(), prefs.directory).await? else {
            return Ok(None);
        };
        path
    } else {
        prefs.directory
    };
    // The dialog can outlive the account or window that opened it.
    let scope = windows.download_scope(&window, lease)?;
    let owner = app
        .get_webview_window(&scope.owner)
        .ok_or("下载窗口已关闭。")?;
    start_in_directory(
        &owner,
        &backend,
        &downloads,
        api.client(),
        DownloadSpec {
            media_id: input.media_id,
            name: input.name,
            token: scope.token.to_string(),
        },
        directory,
        CancellationToken::new(),
    )
    .map(Some)
}

pub(crate) fn start_in_directory(
    window: &WebviewWindow,
    backend: &Backend,
    downloads: &Downloads,
    client: Client,
    spec: DownloadSpec,
    directory: PathBuf,
    cancel: CancellationToken,
) -> Result<String, &'static str> {
    if cancel.is_cancelled() {
        return Err("下载已取消。");
    }
    let owner = Owner::new(window, &spec.token)?;
    let name = safe_file_name(&spec.name);
    let id = Uuid::new_v4();
    {
        let mut queue = downloads.0.queue.lock().map_err(|_| "无法读取下载任务。")?;
        if let Some(entry) = queue.items.values().find(|entry| {
            entry.owner == owner
                && entry.task.status.active()
                && !entry.cancel.is_cancelled()
                && entry.media_id == spec.media_id
                && entry.directory == directory
                && entry.task.name == name
        }) {
            return Ok(entry.task.id.clone());
        }
        if queue
            .items
            .values()
            .filter(|entry| entry.task.status.active())
            .count()
            >= QUEUE_LIMIT
        {
            return Err("下载任务已满，请稍后重试。");
        }
        queue.sequence += 1;
        let sequence = queue.sequence;
        queue.items.insert(
            id,
            Entry {
                owner: owner.clone(),
                media_id: spec.media_id,
                directory: directory.clone(),
                sequence,
                cancel: cancel.clone(),
                task: Task {
                    id: id.to_string(),
                    name: name.clone(),
                    status: Status::Queued,
                    received: 0,
                    total: None,
                    error: None,
                    saved_path: None,
                },
            },
        );
    }
    let state = downloads.clone();
    let work = Job {
        id,
        client,
        name,
        directory,
        token: spec.token,
        cancel,
        grant_url: backend.media_grant_request(window.label(), spec.media_id),
    };
    tauri::async_runtime::spawn(async move {
        let result = state.download(work).await;
        state.finish(id, &owner, result);
    });
    Ok(id.to_string())
}

#[tauri::command]
pub fn list_downloads(
    window: WebviewWindow,
    downloads: State<'_, Downloads>,
    token: String,
) -> Result<Vec<Task>, &'static str> {
    let owner = Owner::new(&window, &token)?;
    let queue = downloads.0.queue.lock().map_err(|_| "无法读取下载任务。")?;
    let mut entries: Vec<_> = queue
        .items
        .values()
        .filter(|entry| entry.owner == owner)
        .collect();
    entries.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.sequence));
    Ok(entries
        .into_iter()
        .map(|entry| entry.task.clone())
        .collect())
}

#[tauri::command]
pub fn cancel_download(
    window: WebviewWindow,
    downloads: State<'_, Downloads>,
    token: String,
    id: Uuid,
) -> Result<(), &'static str> {
    let owner = Owner::new(&window, &token)?;
    let queue = downloads.0.queue.lock().map_err(|_| "无法取消下载。")?;
    if let Some(entry) = queue.items.get(&id) {
        if entry.owner == owner && entry.task.status.active() {
            entry.cancel.cancel();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_account_downloads(
    window: WebviewWindow,
    downloads: State<'_, Downloads>,
    token: String,
) -> Result<(), &'static str> {
    let owner = Owner::new(&window, &token)?;
    let mut queue = downloads.0.queue.lock().map_err(|_| "无法清理下载任务。")?;
    queue.items.retain(|_, entry| {
        if entry.owner != owner {
            return true;
        }
        entry.cancel.cancel();
        false
    });
    Ok(())
}

impl Downloads {
    async fn download(&self, job: Job) -> Result<PathBuf, &'static str> {
        let _slot = tokio::select! {
            biased;
            _ = job.cancel.cancelled() => return Err("下载已取消。"),
            slot = timeout(DOWNLOAD_QUEUE_TIMEOUT, self.0.slots.acquire()) =>
                slot.map_err(|_| "下载排队超时，请重试。")?.map_err(|_| "无法开始下载。")?,
        };
        self.update(job.id, |task| task.status = Status::Running);
        fs::create_dir_all(&job.directory)
            .await
            .map_err(|_| "无法创建下载目录。")?;
        let temporary = job
            .directory
            .join(format!(".pulse-download-{}.part", job.id));
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await
            .map_err(|_| "无法写入下载目录。")?;
        let transfer = tokio::select! {
            biased;
            _ = job.cancel.cancelled() => Err("下载已取消。"),
            result = self.transfer(&job, &mut output) => result,
        };
        drop(output);
        let result = match transfer {
            Ok(()) => publish(&temporary, &job.directory, &job.name, &job.cancel).await,
            Err(error) => Err(error),
        };
        let _ = fs::remove_file(&temporary).await;
        result
    }

    async fn transfer(&self, job: &Job, output: &mut fs::File) -> Result<(), &'static str> {
        #[derive(Deserialize)]
        struct Grant {
            content_path: String,
        }
        let grant = job
            .client
            .post(job.grant_url.clone())
            .timeout(Duration::from_secs(15))
            .bearer_auth(&job.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body("{}")
            .send()
            .await
            .map_err(|_| "无法获取文件下载授权。")?;
        if !grant.status().is_success()
            || grant.content_length().is_some_and(|size| size > 32 * 1024)
        {
            return Err("附件不可访问或下载授权已失效。");
        }
        let grant = grant
            .json::<Grant>()
            .await
            .map_err(|_| "文件下载授权无效。")?;
        let content_url = Backend::grant_content_url(&job.grant_url, &grant.content_path)?;
        let mut response = job
            .client
            .get(content_url)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|_| "下载连接失败。")?;
        if !response.status().is_success() {
            return Err("文件下载失败，请重试。");
        }
        let total = response.content_length();
        if total.is_some_and(|size| size > MAX_FILE_SIZE) {
            return Err("文件超过当前下载大小限制。");
        }
        self.update(job.id, |task| task.total = total);
        let mut received = 0;
        while let Some(data) = response
            .chunk()
            .await
            .map_err(|_| "文件传输中断，请重试。")?
        {
            received += data.len() as u64;
            if received > MAX_FILE_SIZE {
                return Err("文件超过当前下载大小限制。");
            }
            output
                .write_all(&data)
                .await
                .map_err(|_| "无法写入下载文件。")?;
            self.update(job.id, |task| task.received = received);
        }
        if total.is_some_and(|size| received != size) {
            return Err("文件传输不完整，请重试。");
        }
        output.sync_all().await.map_err(|_| "无法保存下载文件。")
    }
}

fn safe_file_name(value: &str) -> String {
    let clean: String = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .take(100)
        .map(|char| {
            if char.is_control() || matches!(char, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                char
            }
        })
        .collect();
    let clean = clean.trim_end_matches(['.', ' ']);
    if clean.is_empty() {
        return "下载文件".to_owned();
    }
    let reserved = clean
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    if matches!(
        reserved.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        reserved.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    }) {
        format!("_{clean}")
    } else {
        clean.to_owned()
    }
}

async fn publish(
    temp: &Path,
    directory: &Path,
    name: &str,
    cancel: &CancellationToken,
) -> Result<PathBuf, &'static str> {
    let filename = Path::new(name);
    let stem = filename
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    let suffix = filename
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    for index in 0..10000 {
        if cancel.is_cancelled() {
            return Err("下载已取消。");
        }
        let name = if index == 0 {
            name.to_owned()
        } else {
            format!("{stem} ({index}){suffix}")
        };
        let target = directory.join(name);
        match fs::hard_link(temp, &target).await {
            Ok(()) => return Ok(target),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法安全保存到此目录，请选择本机下载目录。"),
        }
    }
    Err("同名文件过多，请更换下载目录。")
}
