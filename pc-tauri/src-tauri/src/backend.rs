use serde::Serialize;
use tauri::{State, Url};

use crate::{detached::DetachedWindows, routes::Routing};

pub struct Backend {
    authority: Url,
    pub(crate) routes: Routing,
}

impl Backend {
    pub fn new() -> Self {
        #[cfg(debug_assertions)]
        if std::env::var("PULSE_DESKTOP_LOCAL_GO").as_deref() == Ok("1") {
            return Self::from_authority(Url::parse("http://127.0.0.1:18080/api/v2").unwrap());
        }
        Self::from_authority(Url::parse("https://api.imapi.shop/api/v2").unwrap())
    }

    fn from_authority(authority: Url) -> Self {
        Self {
            routes: Routing::new(authority.clone()),
            authority,
        }
    }

    pub(crate) fn url(&self, owner: &str, path: &str) -> Url {
        let mut url = self.routes.current_base(owner);
        url.set_path(path);
        url
    }

    pub fn signin_key(&self) -> String {
        self.authority.to_string()
    }

    pub fn api_url(&self, owner: &str, requested: &str) -> Result<Url, &'static str> {
        let url = Url::parse(requested).map_err(|_| "invalid_api_url")?;
        if !self.routes.known_origin(&url)
            || !url.path().starts_with("/api/v2/")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("invalid_api_url");
        }
        Ok(self.routes.apply(owner, &url))
    }

    pub fn media_grant_request(&self, owner: &str, media_id: uuid::Uuid) -> Url {
        self.url(owner, &format!("/api/v2/media/{media_id}/grants"))
    }

    pub fn grant_content_url(backend: &Url, path: &str) -> Result<Url, &'static str> {
        let valid = path
            .strip_prefix("/api/v2/media-grants/")
            .and_then(|value| value.strip_suffix("/content"))
            .is_some_and(|token| {
                token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        if !valid {
            return Err("文件下载授权无效。");
        }
        Ok(backend.join(path).map_err(|_| "文件下载地址无效。")?)
    }

    pub fn realtime_url(&self, owner: &str, ticket: &str) -> Url {
        let mut url = self.routes.current_base(owner);
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).expect("HTTP backend scheme");
        url.set_path("/api/v2/realtime");
        url.query_pairs_mut().append_pair("ticket", ticket);
        url
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    api_base: String,
    route_base: String,
    media_origins: Vec<String>,
    window_kind: &'static str,
    version: String,
}

#[tauri::command]
pub fn desktop_info(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    backend: State<'_, Backend>,
    windows: State<'_, DetachedWindows>,
) -> DesktopInfo {
    DesktopInfo {
        api_base: backend.authority.to_string(),
        route_base: windows
            .network_owner(&window)
            .ok()
            .map(|owner| backend.routes.current_base(&owner).to_string())
            .unwrap_or_else(|| backend.authority.to_string()),
        media_origins: backend.routes.origins(),
        window_kind: if window.label() == crate::notifications::LABEL {
            "notification"
        } else if window.label().starts_with("history-") {
            "history"
        } else if window.label().starts_with("image-") {
            "image"
        } else if window.label().starts_with("screenshot-") {
            "screenshot"
        } else if crate::workspace::conversation_window(window.label()) {
            "conversation"
        } else {
            "workspace"
        },
        version: app.package_info().version.to_string(),
    }
}
