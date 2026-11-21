use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewWindow};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::{
    backend::Backend, detached::DetachedWindows, http::ApiTransport, realtime::Realtime, workspace,
};

const PRIMARY: &str = "go-main";
const ROUTES_ERROR: &str = "暂时无法读取线路清单。";
const ROUTE_ERROR: &str = "线路暂时无法连接，请稍后重试。";
const ROUTE_EVENT: &str = "pulse-desktop-route";
const MAX_CONFIG: usize = 128 * 1024;
const MAX_ROUTES: usize = 32;
const FRESHNESS: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct Route {
    id: String,
    name: String,
    origin: Url,
}

fn primary(authority: &Url) -> Route {
    Route {
        id: PRIMARY.to_owned(),
        name: "主线路".to_owned(),
        origin: authority.clone(),
    }
}

#[derive(Deserialize)]
struct DirectoryResponse {
    #[serde(default)]
    routes: Option<Vec<WireRoute>>,
}

#[derive(Deserialize)]
struct WireRoute {
    id: String,
    name: String,
    api_url: String,
    enabled: bool,
}

#[derive(Default)]
struct Directory {
    checked: Option<Instant>,
    candidates: Vec<Route>,
    timings: HashMap<Url, u64>,
}

pub(crate) struct Routing {
    authority: Url,
    directory: RwLock<Directory>,
    selected: RwLock<HashMap<String, Route>>,
    recovery: Mutex<HashMap<String, Arc<AsyncMutex<Option<Instant>>>>>,
    refreshing: AsyncMutex<()>,
}

impl Routing {
    pub fn new(authority: Url) -> Self {
        Self {
            authority,
            directory: RwLock::new(Directory::default()),
            selected: RwLock::new(HashMap::new()),
            recovery: Mutex::new(HashMap::new()),
            refreshing: AsyncMutex::new(()),
        }
    }

    pub fn current_base(&self, owner: &str) -> Url {
        self.selected
            .read()
            .ok()
            .and_then(|selected| selected.get(owner).map(|route| route.origin.clone()))
            .unwrap_or_else(|| self.authority.clone())
    }

    pub fn apply(&self, owner: &str, request: &Url) -> Url {
        let mut target = self.current_base(owner);
        target.set_path(request.path());
        target.set_query(request.query());
        target
    }

    pub fn origins(&self) -> Vec<String> {
        if let Ok(directory) = self.directory.read() {
            if !directory.candidates.is_empty() {
                return directory
                    .candidates
                    .iter()
                    .map(|route| route.origin.origin().ascii_serialization())
                    .collect();
            }
        }
        vec![self.authority.origin().ascii_serialization()]
    }

    pub fn known_origin(&self, request: &Url) -> bool {
        request.origin() == self.authority.origin()
            || self.directory.read().is_ok_and(|directory| {
                directory
                    .candidates
                    .iter()
                    .any(|route| route.origin.origin() == request.origin())
            })
    }

    pub fn remove(&self, label: &str) {
        if let Ok(mut selected) = self.selected.write() {
            selected.remove(label);
        }
        if let Ok(mut recovery) = self.recovery.lock() {
            recovery.remove(label);
        }
    }

    async fn refresh(
        &self,
        client: &reqwest::Client,
        manual: bool,
    ) -> Result<Vec<String>, &'static str> {
        let _guard = self.refreshing.lock().await;
        let ttl = if manual {
            Duration::from_secs(3)
        } else {
            FRESHNESS
        };
        if self
            .directory
            .read()
            .map_err(|_| ROUTES_ERROR)?
            .checked
            .is_some_and(|time| time.elapsed() < ttl)
        {
            return Ok(Vec::new());
        }
        let response = read_config(client, &self.authority)
            .await
            .map_err(|_| ROUTES_ERROR)?;
        let directory =
            serde_json::from_slice::<DirectoryResponse>(&response).map_err(|_| ROUTES_ERROR)?;
        let routes = directory.routes.unwrap_or_default();
        if routes.len() > MAX_ROUTES {
            return Err(ROUTES_ERROR);
        }
        let mut seen_ids = HashSet::from([PRIMARY.to_owned()]);
        let mut seen_urls = HashSet::from([self.authority.clone()]);
        let mut candidates = vec![primary(&self.authority)];
        for raw in routes.into_iter().filter(|route| route.enabled) {
            let Ok(origin) = Url::parse(&raw.api_url) else {
                continue;
            };
            let origin = checked_route(origin, &self.authority);
            let Some(origin) = origin else { continue };
            if raw.id.len() > 80
                || raw.id.is_empty()
                || !raw
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                || seen_ids.contains(&raw.id)
                || seen_urls.contains(&origin)
            {
                continue;
            }
            seen_ids.insert(raw.id.clone());
            seen_urls.insert(origin.clone());
            let name: String = raw
                .name
                .trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(64)
                .collect();
            candidates.push(Route {
                id: raw.id,
                name: if name.is_empty() {
                    "备用线路".into()
                } else {
                    name
                },
                origin,
            });
        }
        let mut live = self.directory.write().map_err(|_| ROUTES_ERROR)?;
        live.timings.retain(|url, _| seen_urls.contains(url));
        live.candidates = candidates;
        live.checked = Some(Instant::now());
        let mut selected = self.selected.write().map_err(|_| ROUTES_ERROR)?;
        let mut reset = Vec::new();
        selected.retain(|owner, old| {
            let current = live
                .candidates
                .iter()
                .find(|route| route.id == old.id && route.origin == old.origin);
            if let Some(current) = current {
                old.name.clone_from(&current.name);
                true
            } else {
                reset.push(owner.clone());
                false
            }
        });
        Ok(reset)
    }

    fn route(&self, id: &str) -> Option<Route> {
        if id == PRIMARY {
            return Some(primary(&self.authority));
        }
        self.directory
            .read()
            .ok()?
            .candidates
            .iter()
            .find(|route| route.id == id)
            .cloned()
    }

    fn snapshot(&self, owner: &str) -> Result<RoutesView, &'static str> {
        let directory = self.directory.read().map_err(|_| ROUTES_ERROR)?;
        let current = self
            .selected
            .read()
            .map_err(|_| ROUTES_ERROR)?
            .get(owner)
            .cloned()
            .unwrap_or_else(|| primary(&self.authority));
        let seed = [primary(&self.authority)];
        let routes = if directory.candidates.is_empty() {
            &seed[..]
        } else {
            &directory.candidates[..]
        };
        Ok(RoutesView {
            current_id: current.id.clone(),
            base: current.origin.to_string(),
            origins: routes
                .iter()
                .map(|route| route.origin.origin().ascii_serialization())
                .collect(),
            routes: routes
                .iter()
                .map(|route| RouteView {
                    id: route.id.clone(),
                    name: route.name.clone(),
                    latency_ms: directory.timings.get(&route.origin).copied(),
                })
                .collect(),
        })
    }

    async fn probe(&self, client: &reqwest::Client, route: &Route) -> Result<(), &'static str> {
        let start = Instant::now();
        let response = read_config(client, &route.origin).await?;
        let document =
            serde_json::from_slice::<serde_json::Value>(&response).map_err(|_| ROUTE_ERROR)?;
        if document.get("protocol").and_then(serde_json::Value::as_str) != Some("pulse-v2") {
            return Err(ROUTE_ERROR);
        }
        self.directory
            .write()
            .map_err(|_| ROUTES_ERROR)?
            .timings
            .insert(route.origin.clone(), start.elapsed().as_millis() as u64);
        Ok(())
    }

    fn choose(&self, owner: &str, route: Route) -> Result<(), &'static str> {
        let directory = self.directory.read().map_err(|_| ROUTE_ERROR)?;
        let live = if route.id == PRIMARY && route.origin == self.authority {
            primary(&self.authority)
        } else {
            directory
                .candidates
                .iter()
                .find(|live| live.id == route.id && live.origin == route.origin)
                .cloned()
                .ok_or(ROUTE_ERROR)?
        };
        self.selected
            .write()
            .map_err(|_| ROUTES_ERROR)?
            .insert(owner.to_owned(), live);
        Ok(())
    }
}

fn checked_route(mut url: Url, authority: &Url) -> Option<Url> {
    let local = cfg!(debug_assertions)
        && authority.scheme() == "http"
        && authority.host_str() == Some("127.0.0.1")
        && url.host_str() == Some("127.0.0.1");
    if url.host_str().is_none()
        || (url.scheme() != "https" && !(local && url.scheme() == "http"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().trim_end_matches('/') != "/api/v2"
    {
        return None;
    }
    url.set_path("/api/v2");
    Some(url)
}

async fn read_config(client: &reqwest::Client, endpoint: &Url) -> Result<Vec<u8>, &'static str> {
    let mut target = endpoint.clone();
    target.set_path("/api/v2/client/config");
    let mut reply = client
        .get(target)
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|_| ROUTE_ERROR)?;
    if !reply.status().is_success()
        || reply
            .content_length()
            .is_some_and(|size| size > MAX_CONFIG as u64)
    {
        return Err(ROUTE_ERROR);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = reply.chunk().await.map_err(|_| ROUTE_ERROR)? {
        if bytes.len() + chunk.len() > MAX_CONFIG {
            return Err(ROUTE_ERROR);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteView {
    id: String,
    name: String,
    latency_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutesView {
    current_id: String,
    base: String,
    origins: Vec<String>,
    routes: Vec<RouteView>,
}

fn require_workspace(window: &WebviewWindow) -> Result<(), &'static str> {
    if workspace::is_workspace(window.label())
        && window.url().is_ok_and(|url| workspace::trusted_page(&url))
    {
        Ok(())
    } else {
        Err(ROUTES_ERROR)
    }
}

fn preference(app: &AppHandle, owner: &str) -> Result<PathBuf, &'static str> {
    let data = crate::storage::data(app).map_err(|_| ROUTES_ERROR)?;
    Ok(data.join("route-preferences").join(format!("{owner}.json")))
}

fn save_preference(file: &Path, id: &str) -> io::Result<()> {
    let parent = file.parent().ok_or(io::ErrorKind::InvalidInput)?;
    std::fs::create_dir_all(parent)?;
    let temp = parent.join(format!("route-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec(id)?;
    let result = std::fs::write(&temp, bytes).and_then(|_| std::fs::rename(&temp, file));
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

fn changed(app: &AppHandle, owner: &str, view: &RoutesView) {
    let _ = app.emit_to(owner, ROUTE_EVENT, view);
    app.state::<Realtime>().close_window(owner);
    for label in app.state::<DetachedWindows>().network_children(owner) {
        let _ = app.emit_to(label, ROUTE_EVENT, view);
    }
}

#[tauri::command]
pub async fn desktop_routes(
    app: AppHandle,
    window: WebviewWindow,
    backend: State<'_, Backend>,
    api: State<'_, ApiTransport>,
    refresh: bool,
    restore: bool,
) -> Result<RoutesView, &'static str> {
    require_workspace(&window)?;
    let owner = window.label();
    let routes = &backend.routes;
    if refresh || restore {
        for reset in routes.refresh(&api.client(), refresh).await? {
            if let Ok(view) = routes.snapshot(&reset) {
                changed(&app, &reset, &view);
            }
        }
    }
    let previous = routes.current_base(owner);
    if restore {
        let path = preference(&app, owner)?;
        let preferred = tokio::fs::read(path)
            .await
            .ok()
            .filter(|bytes| bytes.len() <= 256)
            .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok());
        if let Some(route) = preferred.as_deref().and_then(|id| routes.route(id)) {
            if route.origin != previous && routes.probe(&api.client(), &route).await.is_ok() {
                routes.choose(owner, route)?;
            }
        }
    }
    let view = routes.snapshot(owner)?;
    if routes.current_base(owner) != previous {
        changed(&app, owner, &view);
    }
    Ok(view)
}

#[tauri::command]
pub async fn select_desktop_route(
    app: AppHandle,
    window: WebviewWindow,
    backend: State<'_, Backend>,
    api: State<'_, ApiTransport>,
    id: String,
) -> Result<RoutesView, &'static str> {
    require_workspace(&window)?;
    let routes = &backend.routes;
    let owner = window.label();
    let route = routes.route(&id).ok_or(ROUTE_ERROR)?;
    routes.probe(&api.client(), &route).await?;
    require_workspace(&window)?;
    let path = preference(&app, owner)?;
    tauri::async_runtime::spawn_blocking(move || save_preference(&path, &id))
        .await
        .map_err(|_| ROUTE_ERROR)?
        .map_err(|_| "无法保存线路偏好。")?;
    let previous = routes.current_base(owner);
    routes.choose(owner, route)?;
    let view = routes.snapshot(owner)?;
    if routes.current_base(owner) != previous {
        changed(&app, owner, &view);
    }
    Ok(view)
}

#[tauri::command]
pub async fn probe_desktop_route(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    api: State<'_, ApiTransport>,
    id: String,
) -> Result<RoutesView, &'static str> {
    require_workspace(&window)?;
    let routes = &backend.routes;
    let route = routes.route(&id).ok_or(ROUTE_ERROR)?;
    routes.probe(&api.client(), &route).await?;
    routes.snapshot(window.label())
}

#[tauri::command]
pub async fn recover_desktop_route(
    app: AppHandle,
    window: WebviewWindow,
    backend: State<'_, Backend>,
    api: State<'_, ApiTransport>,
    failed_base: String,
) -> Result<Option<RoutesView>, &'static str> {
    let windows = app.state::<DetachedWindows>();
    let owner = windows.network_owner(&window)?;
    let routes = &backend.routes;
    let attempt = routes
        .recovery
        .lock()
        .map_err(|_| ROUTE_ERROR)?
        .entry(owner.clone())
        .or_default()
        .clone();
    let mut last_attempt = attempt.lock().await;
    let previous = routes.current_base(&owner);
    if previous.as_str() != failed_base {
        return routes.snapshot(&owner).map(Some);
    }
    if last_attempt.is_some_and(|time| time.elapsed() < Duration::from_secs(8)) {
        return Ok(None);
    }
    *last_attempt = Some(Instant::now());
    let fallbacks: Vec<_> = routes
        .directory
        .read()
        .map_err(|_| ROUTE_ERROR)?
        .candidates
        .iter()
        .filter(|route| route.origin != previous)
        .take(3)
        .cloned()
        .collect();
    let mut probes = futures_util::stream::FuturesUnordered::new();
    for route in fallbacks {
        let client = api.client();
        probes.push(async move { routes.probe(&client, &route).await.map(|()| route) });
    }
    use futures_util::StreamExt;
    while let Some(result) = probes.next().await {
        if let Ok(route) = result {
            if windows.network_owner(&window)? != owner {
                return Ok(None);
            }
            let now = routes.current_base(&owner);
            if now == previous {
                routes.choose(&owner, route)?;
                let view = routes.snapshot(&owner)?;
                changed(&app, &owner, &view);
                return Ok(Some(view));
            }
            return routes.snapshot(&owner).map(Some);
        }
    }
    Ok(None)
}
