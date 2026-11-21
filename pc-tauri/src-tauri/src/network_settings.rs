use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

use reqwest::{Client, Proxy, Url};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    backend::Backend, detached::DetachedWindows, http::ApiTransport, local_protection,
    realtime::Realtime, workspace,
};

const LIMIT: u64 = 128 * 1024;
const PRESET_LIMIT: usize = 32;
const MAGIC: &[u8] = b"PULSE-NETWORK-PREFERENCES-1\n";
const CONTEXT: &[u8] = b"Pulse IM Windows proxy preferences v1";
const READ_ERROR: &str = "无法读取本机代理设置。";
const SAVE_ERROR: &str = "无法保存本机代理设置。";
const PROBE_ERROR: &str = "无法通过此配置连接服务器，请检查代理地址和凭据。";
const CANCELLED: &str = "连接测试已取消。";

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProxyMode {
    #[default]
    Direct,
    System,
    Custom,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedProxy {
    id: Uuid,
    name: String,
    url: String,
}

impl Drop for SavedProxy {
    fn drop(&mut self) {
        self.url.zeroize();
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPreferences {
    #[serde(default)]
    mode: ProxyMode,
    #[serde(default)]
    proxy_url: String,
    #[serde(default)]
    use_ipv6: bool,
    #[serde(default)]
    saved: Vec<SavedProxy>,
    active_proxy_id: Option<Uuid>,
}

impl Drop for NetworkPreferences {
    fn drop(&mut self) {
        self.proxy_url.zeroize();
    }
}

impl NetworkPreferences {
    fn validate(&self) -> Result<(), &'static str> {
        if self.proxy_url.len() > 2048 || self.saved.len() > PRESET_LIMIT {
            return Err("代理设置超出长度或数量限制。");
        }
        if matches!(self.mode, ProxyMode::Custom) {
            proxy_url(&self.proxy_url)?;
        }
        let mut ids = HashSet::new();
        for preset in &self.saved {
            if preset.id.is_nil()
                || !ids.insert(preset.id)
                || preset.name.trim().is_empty()
                || preset.name.chars().count() > 80
                || preset.name.chars().any(char::is_control)
            {
                return Err("代理预设无效。");
            }
            proxy_url(&preset.url)?;
        }
        if self.active_proxy_id.is_some_and(|id| !ids.contains(&id)) {
            return Err("所选代理预设不存在。");
        }
        Ok(())
    }
}

fn proxy_url(raw: &str) -> Result<Url, &'static str> {
    const INVALID: &str = "请输入有效的 HTTP、HTTPS、SOCKS4 或 SOCKS5 代理地址。";
    if raw.len() > 2048 || raw.chars().any(char::is_control) {
        return Err(INVALID);
    }
    let url = Url::parse(raw.trim()).map_err(|_| INVALID)?;
    if !matches!(
        url.scheme(),
        "http" | "https" | "socks4" | "socks5" | "socks5h"
    ) || url.host_str().is_none()
        || url.port() == Some(0)
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(INVALID);
    }
    if url.scheme() == "socks4" && (!url.username().is_empty() || url.password().is_some()) {
        return Err("带用户名或密码的代理请选择 HTTP、HTTPS 或 SOCKS5。");
    }
    Ok(url)
}

struct PreferV6;
impl reqwest::dns::Resolve for PreferV6 {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let mut addresses: Vec<SocketAddr> =
                tokio::net::lookup_host((host, 0)).await?.collect();
            addresses.sort_by_key(SocketAddr::is_ipv4);
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[derive(Clone)]
pub(crate) struct NetworkClients {
    pub http: Client,
    pub websocket: Client,
}

impl NetworkClients {
    fn new(prefs: &NetworkPreferences) -> Result<Self, &'static str> {
        prefs.validate()?;
        Ok(Self {
            http: Self::build(prefs, false)?,
            websocket: Self::build(prefs, true)?,
        })
    }

    fn build(prefs: &NetworkPreferences, websocket: bool) -> Result<Client, &'static str> {
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(6))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(if websocket { 2 } else { 12 })
            .redirect(reqwest::redirect::Policy::none());
        if websocket {
            builder = builder.http1_only();
        }
        if prefs.use_ipv6 {
            builder = builder.dns_resolver(Arc::new(PreferV6));
        }
        builder = match prefs.mode {
            ProxyMode::Direct => builder.no_proxy(),
            ProxyMode::System => builder,
            ProxyMode::Custom => {
                builder.proxy(Proxy::all(proxy_url(&prefs.proxy_url)?).map_err(|_| SAVE_ERROR)?)
            }
        };
        builder.build().map_err(|_| SAVE_ERROR)
    }
}

struct Installed {
    preferences: NetworkPreferences,
    clients: NetworkClients,
    revision: Uuid,
    read_error: bool,
}

pub(crate) struct NetworkSettings {
    path: PathBuf,
    active: RwLock<Installed>,
    writing: tokio::sync::Mutex<()>,
    probes: Mutex<HashMap<String, (Uuid, CancellationToken)>>,
    exit_probes: Mutex<HashMap<String, Instant>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOptions {
    #[serde(flatten)]
    preferences: NetworkPreferences,
    revision: Uuid,
    read_error: bool,
}

impl NetworkSettings {
    pub fn load(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let path = crate::storage::data(app)?
            .join("network-preferences-v1.dat");
        let (preferences, read_error) = match read(&path) {
            Ok(prefs) => (prefs, false),
            Err(_) => (NetworkPreferences::default(), true),
        };
        let clients = NetworkClients::new(&preferences)?;
        Ok(Self {
            path,
            active: RwLock::new(Installed {
                preferences,
                clients,
                revision: Uuid::new_v4(),
                read_error,
            }),
            writing: tokio::sync::Mutex::new(()),
            probes: Mutex::new(HashMap::new()),
            exit_probes: Mutex::new(HashMap::new()),
        })
    }

    pub fn clients(&self) -> NetworkClients {
        self.active
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clients
            .clone()
    }

    fn options(&self) -> Result<NetworkOptions, &'static str> {
        let current = self.active.read().map_err(|_| READ_ERROR)?;
        Ok(NetworkOptions {
            preferences: current.preferences.clone(),
            revision: current.revision,
            read_error: current.read_error,
        })
    }

    pub fn close_window(&self, label: &str) {
        if let Ok(mut probes) = self.probes.lock() {
            if let Some((_, probe)) = probes.remove(label) {
                probe.cancel();
            }
        }
        if let Ok(mut probes) = self.exit_probes.lock() {
            probes.remove(label);
        }
    }
}

fn read(path: &Path) -> Result<NetworkPreferences, &'static str> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(NetworkPreferences::default())
        }
        Err(_) => return Err(READ_ERROR),
    };
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| READ_ERROR)?;
    if bytes.len() as u64 > LIMIT {
        return Err(READ_ERROR);
    }
    let data = bytes.strip_prefix(MAGIC).ok_or(READ_ERROR)?;
    let plain = local_protection::unseal(data, CONTEXT).ok_or(READ_ERROR)?;
    let prefs = serde_json::from_slice::<NetworkPreferences>(&plain).map_err(|_| READ_ERROR)?;
    prefs.validate()?;
    Ok(prefs)
}

fn save(path: &Path, preferences: &NetworkPreferences) -> Result<(), &'static str> {
    let raw = Zeroizing::new(serde_json::to_vec(preferences).map_err(|_| SAVE_ERROR)?);
    let secured = local_protection::seal(&raw, CONTEXT).ok_or(SAVE_ERROR)?;
    if (secured.len() + MAGIC.len()) as u64 > LIMIT {
        return Err(SAVE_ERROR);
    }
    fs::create_dir_all(path.parent().ok_or(SAVE_ERROR)?).map_err(|_| SAVE_ERROR)?;
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(MAGIC)?;
        file.write_all(&secured)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|_| SAVE_ERROR)
}

fn require_workspace(window: &WebviewWindow) -> Result<(), &'static str> {
    if workspace::is_workspace(window.label())
        && window.url().is_ok_and(|url| workspace::trusted_page(&url))
    {
        Ok(())
    } else {
        Err(READ_ERROR)
    }
}

#[tauri::command]
pub fn desktop_network_settings(
    window: WebviewWindow,
    api: State<'_, ApiTransport>,
) -> Result<NetworkOptions, &'static str> {
    require_workspace(&window)?;
    api.network().options()
}

#[tauri::command]
pub async fn set_desktop_network_settings(
    app: AppHandle,
    window: WebviewWindow,
    backend: State<'_, Backend>,
    api: State<'_, ApiTransport>,
    preferences: NetworkPreferences,
    revision: Uuid,
) -> Result<NetworkOptions, &'static str> {
    require_workspace(&window)?;
    let state = api.network();
    let _guard = state.writing.lock().await;
    if state.active.read().map_err(|_| SAVE_ERROR)?.revision != revision {
        return Err("其他窗口已修改代理设置，请重新读取后再保存。");
    }
    let candidate = preferences.clone();
    let clients = tauri::async_runtime::spawn_blocking(move || NetworkClients::new(&candidate))
        .await
        .map_err(|_| SAVE_ERROR)??;
    if !matches!(preferences.mode, ProxyMode::Direct) {
        let target = backend.url(window.label(), "/api/v2/client/config");
        probe(&clients.http, target).await?;
        require_workspace(&window)?;
    }
    let path = state.path.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || {
        save(&path, &preferences)?;
        Ok::<_, &'static str>(Installed {
            preferences,
            clients,
            revision: Uuid::new_v4(),
            read_error: false,
        })
    })
    .await
    .map_err(|_| SAVE_ERROR)??;
    *state.active.write().map_err(|_| SAVE_ERROR)? = installed;
    app.state::<Realtime>().reconnect_all();
    state.options()
}

#[tauri::command]
pub async fn test_desktop_network_settings(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    api: State<'_, ApiTransport>,
    id: Uuid,
    preferences: NetworkPreferences,
) -> Result<u64, &'static str> {
    require_workspace(&window)?;
    if id.is_nil() {
        return Err(PROBE_ERROR);
    }
    let state = api.network();
    let cancel = CancellationToken::new();
    {
        let mut probes = state.probes.lock().map_err(|_| PROBE_ERROR)?;
        if let Some((_, previous)) = probes.insert(window.label().to_owned(), (id, cancel.clone()))
        {
            previous.cancel();
        }
    }
    let target = backend.url(window.label(), "/api/v2/client/config");
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(CANCELLED),
        result = async {
            let client = tauri::async_runtime::spawn_blocking(move || {
                preferences.validate()?;
                NetworkClients::build(&preferences, false)
            }).await.map_err(|_| PROBE_ERROR)??;
            probe(&client, target).await
        } => result,
    };
    if let Ok(mut probes) = state.probes.lock() {
        if probes
            .get(window.label())
            .is_some_and(|(active, _)| *active == id)
        {
            probes.remove(window.label());
        }
    }
    result
}

#[derive(Deserialize)]
struct ProbeResponse {
    protocol: String,
}

async fn probe(client: &Client, target: Url) -> Result<u64, &'static str> {
    const MAX_CONFIG_BYTES: usize = 128 * 1024;
    let start = Instant::now();
    let mut response = client
        .get(target)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| PROBE_ERROR)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_CONFIG_BYTES as u64)
    {
        return Err(PROBE_ERROR);
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| PROBE_ERROR)? {
        if data.len() + chunk.len() > MAX_CONFIG_BYTES {
            return Err(PROBE_ERROR);
        }
        data.extend_from_slice(&chunk);
    }
    let body: ProbeResponse = serde_json::from_slice(&data).map_err(|_| PROBE_ERROR)?;
    if body.protocol != "pulse-v2" {
        return Err(PROBE_ERROR);
    }
    Ok(start.elapsed().as_millis() as u64)
}

#[tauri::command]
pub fn cancel_desktop_network_probe(
    window: WebviewWindow,
    api: State<'_, ApiTransport>,
    id: Uuid,
) -> Result<(), &'static str> {
    require_workspace(&window)?;
    let probes = api.network().probes.lock().map_err(|_| PROBE_ERROR)?;
    if let Some((active, cancel)) = probes.get(window.label()) {
        if *active == id {
            cancel.cancel();
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireExit {
    ip: std::net::IpAddr,
    fraud_score: Option<f64>,
    is_residential: Option<bool>,
    is_broadcast: Option<bool>,
}

#[derive(Serialize)]
pub struct ClientExit {
    exit_ip: std::net::IpAddr,
    risk_score: Option<f64>,
    is_residential: Option<bool>,
    is_broadcast: Option<bool>,
}

#[tauri::command]
pub async fn desktop_network_exit(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    backend: State<'_, Backend>,
    api: State<'_, ApiTransport>,
    lease: Uuid,
    provider: String,
) -> Result<Option<ClientExit>, &'static str> {
    require_workspace(&window)?;
    if backend.signin_key().starts_with("http://") || provider != "https://my.ippure.com/v1/info" {
        return Ok(None);
    }
    let scope = windows.download_scope(&window, lease)?;
    {
        let mut last = api.network().exit_probes.lock().map_err(|_| PROBE_ERROR)?;
        if last
            .get(window.label())
            .is_some_and(|time| time.elapsed() < Duration::from_secs(60))
        {
            return Ok(None);
        }
        last.insert(window.label().to_owned(), Instant::now());
    }
    let result = tokio::select! {
        biased;
        _ = scope.cancel.cancelled() => None,
        result = async {
            let mut response = api.client().get(provider).timeout(Duration::from_millis(4500)).send().await.ok()?;
            if !response.status().is_success() || response.content_length().is_some_and(|size| size > 16_384) { return None; }
            let mut data = Vec::new();
            while let Some(chunk) = response.chunk().await.ok()? {
                if data.len() + chunk.len() > 16_384 { return None; }
                data.extend_from_slice(&chunk);
            }
            let wire = serde_json::from_slice::<WireExit>(&data).ok()?;
            Some(ClientExit {
                exit_ip: wire.ip,
                risk_score: wire.fraud_score.filter(|score| (0.0..=100.0).contains(score)),
                is_residential: wire.is_residential,
                is_broadcast: wire.is_broadcast,
            })
        } => result,
    };
    Ok(result)
}
