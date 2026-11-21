use std::time::Duration;

use tauri::{
    http::{header, Request, Response, StatusCode},
    Manager, UriSchemeContext, UriSchemeResponder, Url, Wry,
};
use tokio::{sync::Semaphore, time::timeout};

use crate::{backend::Backend, detached::DetachedWindows, http::ApiTransport};

pub const SCHEME: &str = "pulsemedia";
const MAX_FULL: usize = 12 * 1024 * 1024;
const MAX_RANGE: usize = 4 * 1024 * 1024;
static PICTURES: Semaphore = Semaphore::const_new(6);
static PLAYBACK: Semaphore = Semaphore::const_new(3);

pub fn handle(
    context: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let label = context.webview_label().to_owned();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let window = app
                .get_webview_window(&label)
                .ok_or(StatusCode::FORBIDDEN)?;
            let scope = app
                .state::<DetachedWindows>()
                .media_authority(&window)
                .map_err(|_| StatusCode::FORBIDDEN)?;
            let backend = app.state::<Backend>();
            let target = grant_target(request.uri(), &backend).ok_or(StatusCode::BAD_REQUEST)?;
            let client = app.state::<ApiTransport>().client();
            tokio::select! {
                biased;
                _ = scope.cancelled() => Err(StatusCode::FORBIDDEN),
                result = fetch(client, target, request) => result,
            }
        }
        .await;
        responder.respond(result.unwrap_or_else(failure));
    });
}

fn failure(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("static media error response")
}

fn grant_target(uri: &tauri::http::Uri, backend: &Backend) -> Option<Url> {
    if uri.query().is_some() || uri.path().len() > 1536 {
        return None;
    }
    let (origin, path) = uri.path().strip_prefix('/')?.split_once('/')?;
    let origin = percent_encoding::percent_decode_str(origin)
        .decode_utf8()
        .ok()?;
    let mut target = Url::parse(&origin).ok()?;
    if target.origin().ascii_serialization() != origin || !backend.routes.known_origin(&target) {
        return None;
    }
    let (token, variant) = path.strip_prefix("api/v2/media-grants/")?.split_once('/')?;
    if token.len() != 64
        || !token.bytes().all(|value| value.is_ascii_hexdigit())
        || !matches!(variant, "content" | "preview")
    {
        return None;
    }
    target.set_path(&format!("/{path}"));
    Some(target)
}

fn download_range(input: &str) -> Option<String> {
    let (start, end) = input.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(MAX_RANGE as u64);
        return (suffix > 0).then(|| format!("bytes=-{suffix}"));
    }
    let start = start.parse::<u64>().ok()?;
    let limit = start.checked_add(MAX_RANGE as u64 - 1)?;
    let end = if end.is_empty() {
        limit
    } else {
        end.parse::<u64>().ok()?.min(limit)
    };
    (end >= start).then(|| format!("bytes={start}-{end}"))
}

fn is_allowed_media(mime: &str) -> bool {
    let mime = mime.split(';').next().unwrap_or_default().trim();
    mime.starts_with("audio/")
        || mime.starts_with("video/")
        || matches!(
            mime,
            "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/bmp" | "image/avif"
        )
}

async fn fetch(
    client: reqwest::Client,
    target: Url,
    request: Request<Vec<u8>>,
) -> Result<Response<Vec<u8>>, StatusCode> {
    if !matches!(
        *request.method(),
        tauri::http::Method::GET | tauri::http::Method::HEAD
    ) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(download_range)
                .ok_or(StatusCode::RANGE_NOT_SATISFIABLE)
        })
        .transpose()?;
    let playback = range.is_some()
        || request
            .headers()
            .get("sec-fetch-dest")
            .is_some_and(|value| value == "video" || value == "audio");
    let limiter = if playback { &PLAYBACK } else { &PICTURES };
    let _slot = timeout(Duration::from_secs(4), limiter.acquire())
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let head = *request.method() == tauri::http::Method::HEAD;
    let mut upstream = client
        .request(request.method().clone(), target)
        .timeout(Duration::from_secs(30));
    if let Some(range) = &range {
        upstream = upstream.header(header::RANGE, range);
    }
    for name in [
        header::IF_NONE_MATCH,
        header::IF_MODIFIED_SINCE,
        header::IF_RANGE,
    ] {
        if let Some(value) = request
            .headers()
            .get(&name)
            .filter(|value| value.as_bytes().len() <= 1024)
        {
            upstream = upstream.header(name, value);
        }
    }
    let mut upstream = upstream.send().await.map_err(|_| StatusCode::BAD_GATEWAY)?;
    let status = upstream.status();
    if !matches!(
        status,
        StatusCode::OK
            | StatusCode::PARTIAL_CONTENT
            | StatusCode::NOT_MODIFIED
            | StatusCode::RANGE_NOT_SATISFIABLE
    ) {
        return Err(if status.is_redirection() {
            StatusCode::BAD_GATEWAY
        } else {
            status
        });
    }
    let mut response = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "private, no-cache, must-revalidate")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header("cross-origin-resource-policy", "cross-origin")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(value) = upstream.headers().get(&name) {
            response = response.header(name, value);
        }
    }
    if matches!(
        status,
        StatusCode::NOT_MODIFIED | StatusCode::RANGE_NOT_SATISFIABLE
    ) {
        return response
            .body(Vec::new())
            .map_err(|_| StatusCode::BAD_GATEWAY);
    }
    if !upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(is_allowed_media)
    {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    if head {
        if let Some(size) = upstream.headers().get(header::CONTENT_LENGTH) {
            response = response.header(header::CONTENT_LENGTH, size);
        }
        return response
            .body(Vec::new())
            .map_err(|_| StatusCode::BAD_GATEWAY);
    }
    let limit = if status == StatusCode::PARTIAL_CONTENT {
        MAX_RANGE
    } else {
        MAX_FULL
    };
    if upstream
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mut body = Vec::with_capacity(upstream.content_length().unwrap_or(0) as usize);
    while let Some(chunk) = upstream
        .chunk()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
    {
        if body.len() + chunk.len() > limit {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        body.extend_from_slice(&chunk);
    }
    response
        .header(header::CONTENT_LENGTH, body.len())
        .body(body)
        .map_err(|_| StatusCode::BAD_GATEWAY)
}
