use std::{
    ffi::OsStr,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Url, WebviewWindow};
use tokio::sync::Mutex;

use crate::{
    backend::Backend,
    http::ApiTransport,
    workspace::{is_workspace, trusted_page},
};

const CHECK_ERROR: &str = "暂时无法检查更新，请稍后重试。";
const DOWNLOAD_ERROR: &str = "暂时无法打开新版下载地址。";
const MAX_RESPONSE_BYTES: usize = 32 * 1024;
const MANUAL_CACHE: Duration = Duration::from_secs(3);
const BACKGROUND_CACHE: Duration = Duration::from_secs(240);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdate {
    current_version: String,
    latest_version: String,
    minimum_version: String,
    required: bool,
    available: bool,
    notes: String,
    downloadable: bool,
}

#[derive(Deserialize)]
struct WireRelease {
    current_version: String,
    latest_version: String,
    minimum_version: String,
    required: bool,
    update_available: bool,
    notes: String,
    url: String,
}

struct CachedRelease {
    checked_at: Instant,
    update: DesktopUpdate,
    url: Option<Url>,
}

#[derive(Default)]
pub struct UpdateChecks(Mutex<Option<CachedRelease>>);

fn allow_window(window: &WebviewWindow) -> Result<(), &'static str> {
    if is_workspace(window.label()) && window.url().is_ok_and(|url| trusted_page(&url)) {
        Ok(())
    } else {
        Err(CHECK_ERROR)
    }
}

fn release_url(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    let allowed = url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none();
    allowed.then_some(url)
}

async fn read_release(app: &AppHandle) -> Result<CachedRelease, &'static str> {
    let backend = app.state::<Backend>();
    let transport = app.state::<ApiTransport>();
    // Release policy belongs to the configured service authority.
    let mut endpoint = backend.url("", "/api/v2/client/update");
    let version = app.package_info().version.to_string();
    endpoint
        .query_pairs_mut()
        .append_pair("platform", "pc")
        .append_pair("version", &version);
    let mut response = transport
        .client()
        .get(endpoint)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| CHECK_ERROR)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(CHECK_ERROR);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CHECK_ERROR)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(CHECK_ERROR);
        }
        bytes.extend_from_slice(&chunk);
    }
    let result = serde_json::from_slice::<WireRelease>(&bytes).map_err(|_| CHECK_ERROR)?;
    if result.current_version != version {
        return Err(CHECK_ERROR);
    }
    let url = if result.required || result.update_available {
        release_url(&result.url)
    } else {
        None
    };
    Ok(CachedRelease {
        checked_at: Instant::now(),
        update: DesktopUpdate {
            current_version: version,
            latest_version: result.latest_version,
            minimum_version: result.minimum_version,
            required: result.required,
            available: result.update_available,
            notes: result.notes,
            downloadable: url.is_some(),
        },
        url,
    })
}

impl UpdateChecks {
    async fn refresh(&self, app: &AppHandle, manual: bool) -> Result<DesktopUpdate, &'static str> {
        let freshness = if manual {
            MANUAL_CACHE
        } else {
            BACKGROUND_CACHE
        };
        // Keep one request in flight across all of the desktop windows.
        let mut cache = self.0.lock().await;
        if let Some(fresh) = cache
            .as_ref()
            .filter(|value| value.checked_at.elapsed() < freshness)
        {
            return Ok(fresh.update.clone());
        }
        let release = read_release(app).await?;
        let update = release.update.clone();
        *cache = Some(release);
        Ok(update)
    }
}

#[tauri::command]
pub async fn check_desktop_update(
    app: AppHandle,
    window: WebviewWindow,
    checks: State<'_, UpdateChecks>,
    manual: bool,
) -> Result<DesktopUpdate, &'static str> {
    allow_window(&window)?;
    checks.refresh(&app, manual).await
}

#[tauri::command]
pub async fn open_desktop_update(
    app: AppHandle,
    window: WebviewWindow,
    checks: State<'_, UpdateChecks>,
    expected_version: String,
) -> Result<(), &'static str> {
    allow_window(&window)?;
    checks.refresh(&app, false).await?;
    let target = checks
        .0
        .lock()
        .await
        .as_ref()
        .filter(|release| release.update.latest_version == expected_version)
        .and_then(|release| release.url.clone())
        .ok_or("下载地址已变化，请重新检查更新。")?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::windows_shell::open(OsStr::new(target.as_str()))
    })
    .await
    .map_err(|_| DOWNLOAD_ERROR)?
    .then_some(())
    .ok_or(DOWNLOAD_ERROR)
}
