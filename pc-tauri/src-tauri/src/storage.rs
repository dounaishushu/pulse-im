use std::path::PathBuf;

use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(crate) struct Storage(Option<PathBuf>);

impl Storage {
    pub(crate) fn locate() -> std::io::Result<Self> {
        if cfg!(feature = "portable") {
            let exe = std::env::current_exe()?;
            let parent = exe.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
            let root = parent.join("PulseIM-Data");
            // Check write access up front, including when the data folder already exists.
            std::fs::create_dir_all(&root)?;
            let probe = root.join(format!(".write-test-{}", uuid::Uuid::new_v4()));
            std::fs::OpenOptions::new().write(true).create_new(true).open(&probe)?;
            std::fs::remove_file(probe)?;
            Ok(Self(Some(root)))
        } else {
            Ok(Self::default())
        }
    }

    fn path(&self, name: &str) -> Option<PathBuf> {
        self.0.as_ref().map(|root| root.join(name))
    }
}

pub(crate) fn data(app: &AppHandle) -> tauri::Result<PathBuf> {
    app.state::<Storage>().path("Profile").map_or_else(|| app.path().app_data_dir(), Ok)
}

pub(crate) fn cache(app: &AppHandle) -> tauri::Result<PathBuf> {
    app.state::<Storage>().path("Cache").map_or_else(|| app.path().app_cache_dir(), Ok)
}

pub(crate) fn logs(app: &AppHandle) -> tauri::Result<PathBuf> {
    app.state::<Storage>().path("Logs").map_or_else(|| app.path().app_log_dir(), Ok)
}

pub(crate) fn downloads(app: &AppHandle) -> tauri::Result<PathBuf> {
    app.state::<Storage>().path("Downloads").map_or_else(|| app.path().download_dir(), Ok)
}

pub(crate) fn webview(app: &AppHandle) -> Option<PathBuf> {
    app.state::<Storage>().path("WebView2")
}
