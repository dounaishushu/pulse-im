use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::{sync::mpsc, time::timeout};
use tokio_tungstenite::{
    tungstenite::{
        handshake::{client::generate_key, derive_accept_key},
        protocol::{Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};
use tokio_util::sync::CancellationToken;

use crate::{backend::Backend, http::ApiTransport};

const MAX_WINDOW_SOCKETS: usize = 32;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(12);

struct SocketControl {
    cancel: CancellationToken,
    outbound: mpsc::Sender<String>,
}

type SocketKey = (String, String);

#[derive(Clone, Default)]
pub struct Realtime(Arc<Mutex<HashMap<SocketKey, SocketControl>>>);

#[derive(Serialize, Clone)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum SocketEvent {
    Open,
    Message(String),
    Closed,
}

impl Realtime {
    pub fn reconnect_all(&self) {
        if let Ok(sockets) = self.0.lock() {
            for control in sockets.values() {
                control.cancel.cancel();
            }
        }
    }

    pub fn close_window(&self, label: &str) {
        if let Ok(sockets) = self.0.lock() {
            for ((owner, _), control) in sockets.iter() {
                if owner == label {
                    control.cancel.cancel();
                }
            }
        }
    }
}

fn valid_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

#[tauri::command]
pub fn realtime_connect(
    window: WebviewWindow,
    backend: State<'_, Backend>,
    realtime: State<'_, Realtime>,
    api: State<'_, ApiTransport>,
    connection_id: String,
    origin: String,
    ticket: String,
    events: Channel<SocketEvent>,
) -> Result<(), &'static str> {
    if !valid_id(&connection_id)
        || !(20..=256).contains(&ticket.len())
        || !ticket
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("invalid_realtime_ticket");
    }
    let owner = window.label();
    let key = (owner.to_owned(), connection_id);
    let registry = realtime.inner().clone();
    let cancel = CancellationToken::new();
    let (outbound, inbox) = mpsc::channel(8);
    let url;
    {
        let mut sockets = registry.0.lock().map_err(|_| "realtime_unavailable")?;
        url = backend.realtime_url(owner, &ticket);
        if url.origin().ascii_serialization() != origin {
            return Err("realtime_route_changed");
        }
        if sockets.contains_key(&key)
            || sockets.keys().filter(|(label, _)| label == owner).count() >= MAX_WINDOW_SOCKETS
        {
            return Err("realtime_limit");
        }
        sockets.insert(
            key.clone(),
            SocketControl {
                cancel: cancel.clone(),
                outbound,
            },
        );
    }
    let client = api.network().clients().websocket;
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = cancel.cancelled() => {},
            _ = drive_socket(client, url, inbox, &events) => {},
        }
        if let Ok(mut sockets) = registry.0.lock() {
            sockets.remove(&key);
        }
        let _ = events.send(SocketEvent::Closed);
    });
    Ok(())
}

async fn drive_socket(
    client: reqwest::Client,
    url: tauri::Url,
    mut inbox: mpsc::Receiver<String>,
    events: &Channel<SocketEvent>,
) {
    let config = WebSocketConfig::default()
        .max_message_size(Some(4 * 1024 * 1024))
        .max_frame_size(Some(2 * 1024 * 1024));
    let Ok(Some(stream)) = timeout(HANDSHAKE_TIMEOUT, upgrade(client, url)).await else {
        return;
    };
    let mut socket = WebSocketStream::from_raw_socket(stream, Role::Client, Some(config)).await;
    if events.send(SocketEvent::Open).is_err() {
        return;
    }
    loop {
        tokio::select! {
            text = inbox.recv() => {
                let Some(text) = text else { break };
                if socket.send(Message::Text(text.into())).await.is_err() { break }
            }
            frame = socket.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        if events.send(SocketEvent::Message(text.to_string())).is_err() { break }
                    }
                    Some(Ok(Message::Ping(_))) => if socket.flush().await.is_err() { break },
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
}

async fn upgrade(client: reqwest::Client, mut target: tauri::Url) -> Option<reqwest::Upgraded> {
    use reqwest::{header, StatusCode};
    let scheme = if target.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    target.set_scheme(scheme).ok()?;
    let key = generate_key();
    let response = client
        .get(target)
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, &key)
        .send()
        .await
        .ok()?;
    let contains = |name, value: &str| {
        response
            .headers()
            .get_all(name)
            .iter()
            .filter_map(|header| header.to_str().ok())
            .flat_map(|header| header.split(','))
            .any(|part| part.trim().eq_ignore_ascii_case(value))
    };
    let accept = derive_accept_key(key.as_bytes());
    if response.status() != StatusCode::SWITCHING_PROTOCOLS
        || !contains(header::CONNECTION, "upgrade")
        || !contains(header::UPGRADE, "websocket")
        || response
            .headers()
            .get(header::SEC_WEBSOCKET_ACCEPT)
            .and_then(|value| value.to_str().ok())
            != Some(accept.as_str())
        || response
            .headers()
            .contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
        || response
            .headers()
            .contains_key(header::SEC_WEBSOCKET_PROTOCOL)
    {
        return None;
    }
    response.upgrade().await.ok()
}

#[tauri::command]
pub fn realtime_send(
    window: WebviewWindow,
    realtime: State<'_, Realtime>,
    connection_id: String,
    text: String,
) -> Result<(), &'static str> {
    if text != r#"{"type":"ping"}"# {
        return Err("invalid_realtime_message");
    }
    let sockets = realtime.0.lock().map_err(|_| "realtime_unavailable")?;
    let control = sockets
        .get(&(window.label().to_owned(), connection_id))
        .ok_or("realtime_closed")?;
    control
        .outbound
        .try_send(text)
        .map_err(|_| "realtime_unavailable")
}

#[tauri::command]
pub fn realtime_disconnect(
    window: WebviewWindow,
    realtime: State<'_, Realtime>,
    connection_id: String,
) {
    if let Ok(sockets) = realtime.0.lock() {
        if let Some(control) = sockets.get(&(window.label().to_owned(), connection_id)) {
            control.cancel.cancel();
        }
    }
}
