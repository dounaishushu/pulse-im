use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use reqwest::{header, Method, Response, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{ipc::Request, State, WebviewWindow};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
use uuid::Uuid;

use crate::{backend::Backend, network_settings::NetworkSettings, upload_stage::UploadStages};

const MAX_REQUESTS: usize = 128;
const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;
const PENDING_LIFETIME: Duration = Duration::from_secs(20);
const REQUEST_ID_HEADER: &str = "x-pulse-request-id";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpec {
    url: String,
    method: String,
    authorization: Option<String>,
    content_type: Option<String>,
}

struct Pending {
    request: Option<reqwest::RequestBuilder>,
    cancel: CancellationToken,
    created: Instant,
    upload_owner: Option<[u8; 32]>,
}

type RequestKey = (String, String);

pub struct ApiTransport {
    network: NetworkSettings,
    pending: Mutex<HashMap<RequestKey, Pending>>,
}

impl ApiTransport {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            network: NetworkSettings::load(app)?,
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn client(&self) -> reqwest::Client {
        self.network.clients().http
    }

    pub(crate) fn network(&self) -> &NetworkSettings {
        &self.network
    }

    pub fn close_window(&self, label: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.retain(|(owner, _), request| {
                if owner != label {
                    return true;
                }
                request.cancel.cancel();
                false
            });
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiReply {
    status: u16,
    content_type: Option<String>,
    retry_after: Option<String>,
    url: String,
    pub(crate) body: String,
}

fn method(value: &str) -> Result<Method, &'static str> {
    let method = Method::from_bytes(value.as_bytes()).map_err(|_| "invalid_api_method")?;
    if matches!(
        method,
        Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        Ok(method)
    } else {
        Err("invalid_api_method")
    }
}

fn request_key(window: &WebviewWindow, request_id: &str) -> Result<RequestKey, &'static str> {
    if uuid::Uuid::parse_str(request_id).is_err() {
        return Err("invalid_request_id");
    }
    Ok((window.label().to_owned(), request_id.to_owned()))
}

#[tauri::command]
pub fn api_start(
    window: WebviewWindow,
    transport: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
    windows: State<'_, crate::detached::DetachedWindows>,
    request_id: String,
    spec: RequestSpec,
) -> Result<(), &'static str> {
    let key = request_key(&window, &request_id)?;
    let owner_label = windows.network_owner(&window)?;
    let target = backend.api_url(&owner_label, &spec.url)?;
    let method = method(&spec.method)?;
    if let Some(expected) = windows.credential_digest(&window)? {
        let allowed = spec
            .authorization
            .as_deref()
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|token| {
                let claimed: [u8; 32] = Sha256::digest(token.as_bytes()).into();
                claimed == expected
            });
        let path = target.path();
        let changes_session = path.starts_with("/api/v2/auth/")
            && !matches!((method.clone(), path), (Method::GET, "/api/v2/auth/me"));
        if !allowed || changes_session {
            return Err("invalid_api_authorization");
        }
    }
    let media_bytes = method == Method::PUT
        && spec.content_type.as_deref() == Some("application/octet-stream")
        && is_media_upload(&target);
    let mut request = transport
        .client()
        .request(method, target)
        .timeout(Duration::from_secs(if media_bytes { 150 } else { 25 }));
    if let Some(content_type) = spec.content_type {
        if content_type != "application/json" && !media_bytes {
            return Err("invalid_api_content_type");
        }
        request = request.header(header::CONTENT_TYPE, content_type);
    }
    let mut upload_owner = None;
    if let Some(authorization) = spec.authorization {
        if !valid_authorization(&authorization) {
            return Err("invalid_api_authorization");
        }
        if media_bytes {
            upload_owner = Some(Sha256::digest(authorization.as_bytes()).into());
        }
        request = request.header(header::AUTHORIZATION, authorization);
    }
    if media_bytes && upload_owner.is_none() {
        return Err("invalid_api_authorization");
    }

    let mut pending = transport.pending.lock().map_err(|_| "api_unavailable")?;
    pending
        .retain(|_, entry| entry.request.is_none() || entry.created.elapsed() < PENDING_LIFETIME);
    if pending.len() >= MAX_REQUESTS || pending.contains_key(&key) {
        return Err("api_busy");
    }
    pending.insert(
        key,
        Pending {
            request: Some(request),
            cancel: CancellationToken::new(),
            created: Instant::now(),
            upload_owner,
        },
    );
    Ok(())
}

pub(crate) fn valid_authorization(value: &str) -> bool {
    value.strip_prefix("Bearer ").is_some_and(|token| {
        (16..=256).contains(&token.len())
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    })
}

fn is_media_upload(url: &Url) -> bool {
    url.path()
        .strip_prefix("/api/v2/media/")
        .and_then(|rest| rest.strip_suffix("/bytes"))
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

#[tauri::command]
pub async fn api_execute(
    window: WebviewWindow,
    transport: State<'_, ApiTransport>,
    request: Request<'_>,
) -> Result<ApiReply, &'static str> {
    let id = request
        .headers()
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("invalid_request_id")?;
    let key = request_key(&window, id)?;
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(body) => body,
        _ => return Err("invalid_api_body"),
    };
    let (builder, cancel) = {
        let mut pending = transport.pending.lock().map_err(|_| "api_unavailable")?;
        let entry = pending.get_mut(&key).ok_or("api_cancelled")?;
        if entry.upload_owner.is_some() {
            pending.remove(&key);
            return Err("upload_requires_stage");
        }
        if body.len() > MAX_JSON_BYTES {
            pending.remove(&key);
            return Err("api_body_too_large");
        }
        (
            entry.request.take().ok_or("api_already_started")?,
            entry.cancel.clone(),
        )
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("api_cancelled"),
        result = execute(if body.is_empty() { builder } else { builder.body(body.to_vec()) }) => result,
    };
    if let Ok(mut pending) = transport.pending.lock() {
        pending.remove(&key);
    }
    result
}

#[tauri::command]
pub async fn api_execute_upload(
    window: WebviewWindow,
    transport: State<'_, ApiTransport>,
    uploads: State<'_, UploadStages>,
    request_id: String,
    stage_id: Uuid,
) -> Result<ApiReply, &'static str> {
    let key = request_key(&window, &request_id)?;
    let (builder, cancel, owner) = {
        let mut pending = transport.pending.lock().map_err(|_| "api_unavailable")?;
        let entry = pending.get_mut(&key).ok_or("api_cancelled")?;
        let owner = entry.upload_owner.ok_or("invalid_api_upload")?;
        let builder = entry.request.take().ok_or("api_already_started")?;
        (builder, entry.cancel.clone(), owner)
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("api_cancelled"),
        result = async {
            let (file, size, stage_closed) = uploads.open(window.label(), stage_id, owner).await?;
            let stream = ReaderStream::with_capacity(file, 128 * 1024);
            let builder = builder.header(header::CONTENT_LENGTH, size).body(reqwest::Body::wrap_stream(stream));
            tokio::select! {
                biased;
                _ = stage_closed.cancelled() => Err("api_cancelled"),
                response = execute(builder) => response,
            }
        } => result,
    };
    if let Ok(mut pending) = transport.pending.lock() {
        pending.remove(&key);
    }
    result
}

async fn execute(builder: reqwest::RequestBuilder) -> Result<ApiReply, &'static str> {
    let response = builder.send().await.map_err(|_| "api_unavailable")?;
    read_response(response).await
}

pub(crate) async fn read_response(mut response: Response) -> Result<ApiReply, &'static str> {
    let status = response.status();
    let url = response.url().to_string();
    if status.is_redirection() && status != reqwest::StatusCode::NOT_MODIFIED {
        return Err("api_redirect");
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_JSON_BYTES as u64)
    {
        return Err("api_response_too_large");
    }
    let read_header = |name| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let content_type = read_header(header::CONTENT_TYPE);
    let retry_after = read_header(header::RETRY_AFTER);
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "api_unavailable")? {
        if bytes.len() + chunk.len() > MAX_JSON_BYTES {
            return Err("api_response_too_large");
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes).map_err(|_| "invalid_api_response")?;
    Ok(ApiReply {
        status: status.as_u16(),
        content_type,
        retry_after,
        url,
        body,
    })
}

#[tauri::command]
pub fn api_cancel(window: WebviewWindow, transport: State<'_, ApiTransport>, request_id: String) {
    let Ok(key) = request_key(&window, &request_id) else {
        return;
    };
    if let Ok(mut pending) = transport.pending.lock() {
        if let Some(entry) = pending.get(&key) {
            entry.cancel.cancel();
            if entry.request.is_some() {
                pending.remove(&key);
            }
        }
    }
}
