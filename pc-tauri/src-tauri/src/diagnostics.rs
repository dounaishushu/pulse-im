use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::mpsc;

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const LOG_ERROR: &str = "无法打开本地日志目录。";

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticEvent {
    ProcessStarted,
    WorkspaceMounted,
    RendererLongTask,
    RendererError,
    RealtimeDisconnected,
    HttpUnavailable,
    HttpBusy,
}

impl DiagnosticEvent {
    fn renderer_throttle(self) -> Option<(usize, Duration)> {
        let (index, seconds) = match self {
            Self::WorkspaceMounted => (0, 3),
            Self::RendererLongTask => (1, 5),
            Self::RendererError => (2, 10),
            Self::RealtimeDisconnected => (3, 5),
            Self::HttpUnavailable => (4, 5),
            Self::HttpBusy => (5, 5),
            Self::ProcessStarted => return None,
        };
        Some((index, Duration::from_secs(seconds)))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    time_unix_ms: u64,
    event: DiagnosticEvent,
    window_kind: &'static str,
    duration_ms: Option<u32>,
    version: String,
    pid: u32,
}

pub struct Diagnostics {
    directory: PathBuf,
    version: String,
    send: mpsc::Sender<Entry>,
    latest: Mutex<[[Option<Instant>; 6]; 2]>,
}

impl Diagnostics {
    pub fn start(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let directory = crate::storage::logs(app)?;
        let worker_path = directory.clone();
        let (send, mut receive) = mpsc::channel(64);
        std::thread::Builder::new()
            .name("pulse-diagnostics".into())
            .spawn(move || {
                while let Some(entry) = receive.blocking_recv() {
                    let _ = append_entry(&worker_path, entry);
                }
            })?;
        let logs = Self {
            directory,
            version: app.package_info().version.to_string(),
            send,
            latest: Mutex::new([[None; 6]; 2]),
        };
        logs.record(DiagnosticEvent::ProcessStarted, "app", None);
        Ok(logs)
    }

    fn record(&self, event: DiagnosticEvent, window_kind: &'static str, duration_ms: Option<u32>) {
        let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            return;
        };
        let _ = self.send.try_send(Entry {
            time_unix_ms: now.as_millis() as u64,
            event,
            window_kind,
            duration_ms,
            version: self.version.clone(),
            pid: std::process::id(),
        });
    }
}

fn append_entry(directory: &Path, entry: Entry) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let file = directory.join("desktop.log");
    let current_bytes = match fs::symlink_metadata(&file) {
        Ok(metadata) if metadata.is_file() && !metadata.is_symlink() => metadata.len(),
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid log file",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    let mut line = serde_json::to_vec(&entry)?;
    line.push(b'\n');
    if current_bytes + line.len() as u64 > MAX_LOG_BYTES {
        fs::rename(&file, directory.join("desktop.log.1"))?;
    }
    OpenOptions::new()
        .append(true)
        .create(true)
        .open(file)?
        .write_all(&line)
}

#[tauri::command]
pub fn report_desktop_diagnostic(
    app: AppHandle,
    window: WebviewWindow,
    event: DiagnosticEvent,
    duration_ms: Option<u32>,
) {
    if !window
        .url()
        .is_ok_and(|url| crate::workspace::trusted_page(&url))
    {
        return;
    }
    let Some(logs) = app.try_state::<Diagnostics>() else {
        return;
    };
    let Some((event_index, interval)) = event.renderer_throttle() else {
        return;
    };
    let (kind, index) = if crate::workspace::is_workspace(window.label()) {
        ("workspace", 0)
    } else if crate::workspace::conversation_window(window.label()) {
        ("conversation", 1)
    } else {
        return;
    };
    let now = Instant::now();
    if let Ok(mut latest) = logs.latest.lock() {
        if latest[index][event_index].is_some_and(|at| now.duration_since(at) < interval) {
            return;
        }
        latest[index][event_index] = Some(now);
    }
    logs.record(event, kind, duration_ms.filter(|value| *value <= 300_000));
}

pub(crate) async fn open_logs(app: &AppHandle) -> Result<(), &'static str> {
    let logs = app.try_state::<Diagnostics>().ok_or(LOG_ERROR)?;
    let directory = logs.directory.clone();
    tauri::async_runtime::spawn_blocking(move || launch_logs(&directory))
        .await
        .map_err(|_| LOG_ERROR)?
}

#[tauri::command]
pub async fn open_desktop_logs(app: AppHandle, window: WebviewWindow) -> Result<(), &'static str> {
    if !(crate::workspace::is_workspace(window.label())
        || crate::workspace::conversation_window(window.label()))
        || !window
            .url()
            .is_ok_and(|url| crate::workspace::trusted_page(&url))
    {
        return Err(LOG_ERROR);
    }
    open_logs(&app).await
}

fn launch_logs(directory: &Path) -> Result<(), &'static str> {
    fs::create_dir_all(directory).map_err(|_| LOG_ERROR)?;
    crate::windows_shell::open(directory.as_os_str())
        .then_some(())
        .ok_or(LOG_ERROR)
}
