use std::{collections::HashMap, sync::Arc, time::Duration};

use reqwest::StatusCode;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Url;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{backend::Backend, http::read_response, image_copy::ImageCopies};

pub(crate) const PAGE_SIZE: usize = 50;
const JSON_TIMEOUT: Duration = Duration::from_secs(15);
const COPY_IMAGE_LIMIT: usize = 30 * 1024 * 1024;

#[derive(Debug)]
pub(crate) enum Error {
    Cancelled,
    Invalid,
    Network,
    Status(StatusCode),
}

impl Error {
    pub fn closes_history(&self) -> bool {
        matches!(self, Self::Status(status) if matches!(status.as_u16(), 401 | 403 | 404 | 426))
    }

    pub fn text(&self) -> &'static str {
        match self {
            Self::Cancelled => "聊天记录已更新，请重试。",
            Self::Invalid => "聊天记录响应无效，请刷新后重试。",
            Self::Network => "读取聊天记录失败，请检查网络后重试。",
            Self::Status(status) => match status.as_u16() {
                401 => "登录已失效，请重新登录。",
                403 | 404 => "这条消息已不可访问。",
                409 => "会话权限已变化，请刷新聊天记录。",
                426 => "客户端版本过低，请更新后重试。",
                429 => "服务器繁忙，请稍后重试。",
                _ => "读取聊天记录失败，请重试。",
            },
        }
    }
}

#[derive(Deserialize)]
struct WireEventPage {
    events: Vec<WireEvent>,
    next_after_seq: String,
    has_more: bool,
}

#[derive(Deserialize)]
struct WireEvent {
    seq: String,
    kind: String,
    message: EventMessage,
}

#[derive(Deserialize)]
struct EventMessage {
    id: Uuid,
    conversation_id: Uuid,
    revoked: bool,
}

#[derive(Default)]
pub(crate) struct ArchiveChanges {
    pub removed: Vec<Uuid>,
    pub reload: bool,
}

#[derive(Deserialize)]
pub(crate) struct WirePage {
    pub items: Vec<WireMessage>,
    pub membership_version: String,
    pub has_more: bool,
}

#[derive(Deserialize)]
pub(crate) struct WireMessage {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub seq: String,
    pub sender_id: Uuid,
    pub sender: Option<Sender>,
    pub kind: String,
    pub body: String,
    pub content: Option<Content>,
    pub revoked: bool,
    pub created_at: String,
}

#[derive(Deserialize)]
pub(crate) struct Sender {
    pub name: String,
    #[serde(default, deserialize_with = "optional_id")]
    pub avatar_id: Option<Uuid>,
}

fn optional_id<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<Option<Uuid>, D::Error> {
    let value = Option::<String>::deserialize(decoder)?;
    Ok(value.and_then(|value| Uuid::parse_str(&value).ok()))
}

#[derive(Default, Deserialize)]
pub(crate) struct Content {
    pub media: Option<Media>,
    pub contact: Option<Contact>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub(crate) struct Media {
    pub id: Uuid,
    pub filename: String,
    pub mime: String,
    pub bytes: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Contact {
    pub nickname: String,
    pub account: String,
}

#[derive(Deserialize)]
struct Grant {
    content_path: String,
}

#[derive(Deserialize)]
struct GrantRow {
    id: Uuid,
    access: Option<Grant>,
}

pub(crate) struct Reader<'a> {
    pub client: reqwest::Client,
    pub backend: &'a Backend,
    pub route_owner: &'a str,
    pub token: &'a str,
    pub cancel: &'a CancellationToken,
}

impl Reader<'_> {
    async fn json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, Error> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(Error::Cancelled),
            result = async {
                let response = request.bearer_auth(self.token).timeout(JSON_TIMEOUT)
                    .send().await.map_err(|_| Error::Network)?;
                if !response.status().is_success() {
                    return Err(Error::Status(response.status()));
                }
                let payload = read_response(response).await.map_err(|_| Error::Invalid)?;
                serde_json::from_str(&payload.body).map_err(|_| Error::Invalid)
            } => result,
        }
    }

    pub(crate) async fn access(&self, conversation: Uuid) -> Result<(), Error> {
        #[derive(Deserialize)]
        struct Access {
            conversation_id: Uuid,
        }
        let url = self.backend.url(
            self.route_owner,
            &format!("/api/v2/conversations/{conversation}/access"),
        );
        let access: Access = self.json(self.client.get(url)).await?;
        if access.conversation_id != conversation {
            return Err(Error::Invalid);
        }
        Ok(())
    }

    pub async fn page(
        &self,
        conversation: Uuid,
        before: Option<i64>,
        version: Option<i64>,
    ) -> Result<WirePage, Error> {
        let mut url = self.backend.url(
            self.route_owner,
            &format!("/api/v2/conversations/{conversation}/history"),
        );
        url.query_pairs_mut()
            .append_pair("limit", &PAGE_SIZE.to_string())
            .append_pair("order", "desc");
        if let (Some(before), Some(version)) = (before, version) {
            url.query_pairs_mut()
                .append_pair("before_seq", &before.to_string())
                .append_pair("membership_version", &version.to_string());
        }
        self.json(self.client.get(url)).await
    }

    pub async fn changes(
        &self,
        conversation: Uuid,
        after: i64,
        through: i64,
    ) -> Result<ArchiveChanges, Error> {
        let mut change = ArchiveChanges::default();
        let mut cursor = after;
        for _ in 0..4 {
            let mut url = self.backend.url(
                self.route_owner,
                &format!("/api/v2/conversations/{conversation}/sync"),
            );
            url.query_pairs_mut()
                .append_pair("limit", "100")
                .append_pair("after", &cursor.to_string())
                .append_pair("snapshot_max_seq", &through.to_string());
            let page: WireEventPage = self.json(self.client.get(url)).await?;
            let next = page
                .next_after_seq
                .parse::<i64>()
                .map_err(|_| Error::Invalid)?;
            if next <= cursor
                || next > through
                || page.has_more != (next < through)
                || page.events.len() > 100
            {
                return Err(Error::Invalid);
            }
            for event in page.events {
                let number: i64 = event.seq.parse().map_err(|_| Error::Invalid)?;
                if number <= cursor
                    || number > next
                    || event.message.conversation_id != conversation
                {
                    return Err(Error::Invalid);
                }
                cursor = number;
                if event.message.revoked || event.kind == "message.revoked" {
                    change.removed.push(event.message.id);
                } else if event.kind != "message.created" {
                    change.reload = true;
                }
            }
            cursor = next;
            if !page.has_more {
                return Ok(change);
            }
        }
        // A large gap after reconnect is cheaper to refresh than to replay many pages.
        change.reload = true;
        Ok(change)
    }

    pub async fn message(&self, conversation: Uuid, id: Uuid) -> Result<WireMessage, Error> {
        let url = self.backend.url(
            self.route_owner,
            &format!("/api/v2/conversations/{conversation}/messages/{id}"),
        );
        let row: WireMessage = self.json(self.client.get(url)).await?;
        if row.id != id || row.conversation_id != conversation || row.revoked {
            return Err(Error::Status(StatusCode::NOT_FOUND));
        }
        Ok(row)
    }

    pub async fn assets(&self, ids: &[Uuid]) -> Result<HashMap<Uuid, String>, Error> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        #[derive(Deserialize)]
        struct Grants {
            items: Vec<GrantRow>,
        }
        let url = self.backend.url(self.route_owner, "/api/v2/media/grants");
        let grants: Grants = self
            .json(
                self.client
                    .post(url.clone())
                    .json(&serde_json::json!({ "media_ids": ids })),
            )
            .await?;
        grants
            .items
            .into_iter()
            .filter_map(|row| row.access.map(|grant| (row.id, grant)))
            .map(|(id, grant)| {
                if !ids.contains(&id) {
                    return Err(Error::Invalid);
                }
                let target = Backend::grant_content_url(&url, &grant.content_path)
                    .map_err(|_| Error::Invalid)?;
                Ok((id, target.into()))
            })
            .collect()
    }

    pub async fn image(&self, conversation: Uuid, id: Uuid) -> Result<(Media, Url), Error> {
        let row = self.message(conversation, id).await?;
        let media = row
            .content
            .and_then(|content| content.media)
            .filter(|media| row.kind == "image" && media.mime.starts_with("image/"))
            .ok_or(Error::Invalid)?;
        let url = self.backend.media_grant_request(self.route_owner, media.id);
        let grant: Grant = self
            .json(self.client.post(url.clone()).json(&serde_json::json!({})))
            .await?;
        let target =
            Backend::grant_content_url(&url, &grant.content_path).map_err(|_| Error::Invalid)?;
        Ok((media, target))
    }

    pub async fn copy_image(
        &self,
        copies: &ImageCopies,
        window: &tauri::WebviewWindow,
        conversation: Uuid,
        id: Uuid,
    ) -> Result<(), &'static str> {
        #[cfg(windows)]
        let owner = window
            .hwnd()
            .map_err(|_| "无法写入图片到剪贴板，请重试。")?
            .0 as usize;
        #[cfg(not(windows))]
        let owner = {
            let _ = window;
            0
        };
        self.copy_image_using(copies, conversation, id, move |bytes| {
            write_image(owner, bytes)
        })
        .await
    }

    async fn copy_image_using(
        &self,
        copies: &ImageCopies,
        conversation: Uuid,
        id: Uuid,
        write: impl FnOnce(&[u8]) -> Result<(), &'static str> + Send + 'static,
    ) -> Result<(), &'static str> {
        let job = copies.begin(self.cancel)?;
        let slot = job.slot().await?;
        let reader = Reader {
            client: self.client.clone(),
            cancel: job.cancel(),
            ..*self
        };
        // A cache hit must still pass fresh message and media authorization.
        let (media, url) = reader
            .image(conversation, id)
            .await
            .map_err(|error| error.text())?;
        let key = reader.copy_key(conversation, id, &media);
        let pixels = if let Some(pixels) = job.cached(key)? {
            pixels
        } else {
            let bytes = tokio::select! {
                biased;
                _ = job.cancel().cancelled() => return Err("图片复制已取消。"),
                result = reader.read_image(url) => result?,
            };
            let cancel = job.cancel().clone();
            Arc::new(
                tauri::async_runtime::spawn_blocking(move || decode_image(bytes, cancel))
                    .await
                    .map_err(|_| "无法复制图片。")??,
            )
        };
        drop(reader);
        tauri::async_runtime::spawn_blocking(move || {
            let _slot = slot;
            job.commit(key, pixels, write)
        })
        .await
        .map_err(|_| "无法复制图片。")?
    }

    fn copy_key(&self, conversation: Uuid, message: Uuid, media: &Media) -> [u8; 32] {
        let mut key = Sha256::new();
        for value in [
            self.token,
            self.route_owner,
            self.backend
                .media_grant_request(self.route_owner, media.id)
                .as_str(),
        ] {
            key.update((value.len() as u64).to_le_bytes());
            key.update(value.as_bytes());
        }
        key.update(conversation.as_bytes());
        key.update(message.as_bytes());
        key.update(media.id.as_bytes());
        key.update(media.bytes.as_bytes());
        key.update(media.width.to_le_bytes());
        key.update(media.height.to_le_bytes());
        key.finalize().into()
    }

    async fn read_image(&self, url: Url) -> Result<Vec<u8>, &'static str> {
        let mut response = self
            .client
            .get(url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "读取原图失败，请重试。")?;
        if !response.status().is_success() {
            return Err("图片已不可访问。");
        }
        if response
            .content_length()
            .is_some_and(|size| size > COPY_IMAGE_LIMIT as u64)
        {
            return Err("原图太大，无法复制到剪贴板。");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "读取原图中断，请重试。")?
        {
            if bytes.len() + chunk.len() > COPY_IMAGE_LIMIT {
                return Err("原图太大，无法复制到剪贴板。");
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

pub(crate) async fn copy_text(text: String, cancel: CancellationToken) -> Result<(), &'static str> {
    tauri::async_runtime::spawn_blocking(move || {
        if cancel.is_cancelled() {
            return Err("聊天记录窗口已关闭。");
        }
        #[cfg(windows)]
        return clipboard_win::set_clipboard_string(&text).map_err(|_| "无法写入剪贴板，请重试。");
        #[cfg(not(windows))]
        {
            let _ = text;
            Err("此系统暂不支持复制。")
        }
    })
    .await
    .map_err(|_| "无法复制文字。")?
}

#[cfg(windows)]
fn decode_image(bytes: Vec<u8>, cancel: CancellationToken) -> Result<Vec<u8>, &'static str> {
    if cancel.is_cancelled() {
        return Err("图片复制已取消。");
    }
    use std::io::Cursor;
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "图片格式无法读取。")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(10_000);
    limits.max_image_height = Some(10_000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| "图片过大或无法解码。")?;
    let width = image.width();
    let height = image.height();
    if u64::from(width) * u64::from(height) > 20_000_000 {
        return Err("原图太大，无法复制到剪贴板。");
    }
    let mut bitmap = Cursor::new(Vec::new());
    image
        .write_to(&mut bitmap, image::ImageFormat::Bmp)
        .map_err(|_| "无法生成剪贴板图片。")?;
    if cancel.is_cancelled() {
        return Err("图片预览已关闭。");
    }
    Ok(bitmap.into_inner())
}

#[cfg(windows)]
fn write_image(owner: usize, bytes: &[u8]) -> Result<(), &'static str> {
    let _clipboard = clipboard_win::Clipboard::new_attempts_for(owner as _, 10)
        .map_err(|_| "无法写入图片到剪贴板，请重试。")?;
    // Bitmap's default setter appends CF_BITMAP, leaving older PNG/DIB/HTML
    // formats that WebView2 can prefer when pasting. Replace all formats under
    // one lock with a real window owner so EmptyClipboard/SetClipboardData work.
    clipboard_win::empty().map_err(|_| "无法写入图片到剪贴板，请重试。")?;
    clipboard_win::raw::set_bitmap(bytes).map_err(|_| "无法写入图片到剪贴板，请重试。")
}

#[cfg(not(windows))]
fn decode_image(_bytes: Vec<u8>, _cancel: CancellationToken) -> Result<Vec<u8>, &'static str> {
    Err("此系统暂不支持复制图片。")
}

#[cfg(not(windows))]
fn write_image(_owner: usize, _bytes: &[u8]) -> Result<(), &'static str> {
    Err("此系统暂不支持复制图片。")
}

#[cfg(all(test, windows))]
mod image_tests {
    use super::*;

    #[test]
    #[ignore = "requires an isolated clipboard or explicit user-authorized backup/restore controller"]
    fn windows_clipboard_replaces_previous_image_formats() {
        #[link(name = "user32")]
        extern "system" {
            fn GetProcessWindowStation() -> *mut std::ffi::c_void;
            fn GetUserObjectInformationW(
                object: *mut std::ffi::c_void,
                index: i32,
                data: *mut std::ffi::c_void,
                bytes: u32,
                needed: *mut u32,
            ) -> i32;
        }
        let mut station = [0u16; 256];
        let mut needed = 0;
        let found = unsafe {
            GetUserObjectInformationW(
                GetProcessWindowStation(),
                2,
                station.as_mut_ptr().cast(),
                std::mem::size_of_val(&station) as u32,
                &mut needed,
            )
        };
        assert_ne!(found, 0, "cannot verify isolated clipboard station");
        let station = String::from_utf16_lossy(
            &station[..station.iter().position(|value| *value == 0).unwrap()],
        );
        let owned_clipboard = std::env::var("PULSE_CLIPBOARD_TEST_OWNERSHIP")
            .ok()
            .filter(|token| token.len() == 32)
            .is_some_and(|token| {
                let marker = clipboard_win::register_format("PulseClipboardTestScope")
                    .unwrap()
                    .get();
                let _clipboard = clipboard_win::Clipboard::new_attempts(10).unwrap();
                clipboard_win::get::<Vec<u8>, _>(clipboard_win::formats::RawData(marker))
                    .is_ok_and(|bytes| bytes == token.as_bytes())
            });
        assert!(
            station.starts_with("PulseClipboardTest-") || owned_clipboard,
            "refusing to modify a clipboard not owned by the isolated test: {station}"
        );

        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, HWND_MESSAGE,
        };
        struct Owner(windows_sys::Win32::Foundation::HWND);
        impl Drop for Owner {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let owner = Owner(unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        });
        assert!(!owner.0.is_null(), "cannot create test clipboard owner");

        let old = image::RgbImage::from_pixel(17, 11, image::Rgb([210, 30, 60]));
        let selected = image::RgbImage::from_fn(29, 19, |x, y| {
            image::Rgb([(x * 7) as u8, (y * 11) as u8, 150])
        });
        let encode = |image: &image::RgbImage, format| {
            let mut out = std::io::Cursor::new(Vec::new());
            image.write_to(&mut out, format).unwrap();
            out.into_inner()
        };
        let old_png = encode(&old, image::ImageFormat::Png);
        let selected_png = encode(&selected, image::ImageFormat::Png);
        let bitmap = decode_image(selected_png.clone(), CancellationToken::new()).unwrap();
        let png = clipboard_win::register_format("PNG").unwrap().get();
        let html = clipboard_win::register_format("HTML Format").unwrap().get();
        if let Some(output) = std::env::var_os("PULSE_CLIPBOARD_TEST_OUTPUT") {
            std::fs::write(
                std::path::Path::new(&output).join("selected.png"),
                &selected_png,
            )
            .unwrap();
            std::fs::write(std::path::Path::new(&output).join("old.png"), &old_png).unwrap();
        }
        {
            let _clipboard = clipboard_win::Clipboard::new_attempts_for(owner.0 as _, 10).unwrap();
            clipboard_win::empty().unwrap();
            clipboard_win::raw::set_bitmap(&encode(&old, image::ImageFormat::Bmp)).unwrap();
            clipboard_win::raw::set_without_clear(png, &old_png).unwrap();
            clipboard_win::raw::set_without_clear(html, b"stale previous image HTML").unwrap();
        }
        write_image(owner.0 as usize, &bitmap).unwrap();
        {
            let _clipboard = clipboard_win::Clipboard::new_attempts(10).unwrap();
            assert!(
                !clipboard_win::is_format_avail(png),
                "the previous PNG survives and can be pasted instead of the selected image"
            );
            assert!(
                !clipboard_win::is_format_avail(html),
                "the previous HTML survives"
            );
            let actual: Vec<u8> = clipboard_win::get(clipboard_win::formats::Bitmap).unwrap();
            let actual = image::load_from_memory_with_format(&actual, image::ImageFormat::Bmp)
                .unwrap()
                .to_rgb8();
            assert_eq!(actual, selected);
        }
    }

    #[test]
    fn original_pixels_decode_without_any_preview_or_os_clipboard() {
        let image = image::RgbImage::from_pixel(3, 2, image::Rgb([17, 80, 150]));
        let mut png = std::io::Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let bitmap = decode_image(png.into_inner(), CancellationToken::new()).unwrap();
        let decoded = image::load_from_memory_with_format(&bitmap, image::ImageFormat::Bmp)
            .unwrap()
            .to_rgb8();
        assert_eq!(decoded, image);
        assert!(decode_image(vec![0; 12], CancellationToken::new()).is_err());
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(decode_image(vec![], cancelled).is_err());
    }

    #[test]
    fn cache_key_does_not_cross_accounts_messages_or_media() {
        let backend = Backend::new();
        let cancel = CancellationToken::new();
        let reader = Reader {
            client: reqwest::Client::new(),
            backend: &backend,
            route_owner: "isolated-window",
            token: "account-one",
            cancel: &cancel,
        };
        let conversation = Uuid::new_v4();
        let message = Uuid::new_v4();
        let mut media = Media {
            id: Uuid::new_v4(),
            filename: "original.png".into(),
            mime: "image/png".into(),
            bytes: "200".into(),
            width: 3,
            height: 2,
        };
        let original = reader.copy_key(conversation, message, &media);
        assert_ne!(
            original,
            reader.copy_key(conversation, Uuid::new_v4(), &media)
        );
        let other = Reader {
            client: reader.client.clone(),
            token: "account-two",
            ..reader
        };
        assert_ne!(original, other.copy_key(conversation, message, &media));
        media.id = Uuid::new_v4();
        assert_ne!(original, reader.copy_key(conversation, message, &media));
    }

    #[tokio::test]
    async fn cached_copy_still_checks_message_and_grant_but_skips_original_download() {
        use std::sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Mutex,
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::test_authority(
            Url::parse(&format!("http://{}/api/v2", listener.local_addr().unwrap())).unwrap(),
        );
        let conversation = Uuid::new_v4();
        let message = Uuid::new_v4();
        let media = Uuid::new_v4();
        let revoked = Arc::new(AtomicBool::new(false));
        let denied = Arc::new(AtomicBool::new(false));
        let requests = Arc::new([
            AtomicUsize::new(0),
            AtomicUsize::new(0),
            AtomicUsize::new(0),
        ]);
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(3, 2, image::Rgb([17, 80, 150]))
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let png = Arc::new(png.into_inner());
        let serve = {
            let revoked = revoked.clone();
            let denied = denied.clone();
            let requests = requests.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let revoked = revoked.clone();
                    let denied = denied.clone();
                    let requests = requests.clone();
                    let png = png.clone();
                    tokio::spawn(async move {
                        let mut input = Vec::new();
                        let mut buffer = [0; 1024];
                        while !input.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                            let count = socket.read(&mut buffer).await.unwrap();
                            if count == 0 {
                                return;
                            }
                            input.extend_from_slice(&buffer[..count]);
                            if input.len() > 8192 {
                                return;
                            }
                        }
                        let input = String::from_utf8_lossy(&input);
                        let path = input
                            .lines()
                            .next()
                            .unwrap()
                            .split_whitespace()
                            .nth(1)
                            .unwrap();
                        let (status, mime, body) = if path.contains("/messages/") {
                            requests[0].fetch_add(1, Ordering::SeqCst);
                            let row = serde_json::json!({"id":message,"conversation_id":conversation,"seq":"1","sender_id":media,"kind":"image","body":"","content":{"media":{"id":media,"filename":"original.png","mime":"image/png","bytes":"90","width":3,"height":2}},"revoked":false,"created_at":"2026-11-25T00:00:00Z"});
                            (
                                if revoked.load(Ordering::SeqCst) {
                                    404
                                } else {
                                    200
                                },
                                "application/json",
                                serde_json::to_vec(&row).unwrap(),
                            )
                        } else if path.contains("/media/") {
                            requests[1].fetch_add(1, Ordering::SeqCst);
                            (if denied.load(Ordering::SeqCst) {403} else {200}, "application/json", serde_json::to_vec(&serde_json::json!({"content_path":format!("/api/v2/media-grants/{}/content", "a".repeat(64))})).unwrap())
                        } else {
                            requests[2].fetch_add(1, Ordering::SeqCst);
                            (200, "image/png", png.to_vec())
                        };
                        let header = format!("HTTP/1.1 {status} Result\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        socket.write_all(header.as_bytes()).await.unwrap();
                        socket.write_all(&body).await.unwrap();
                    });
                }
            })
        };
        let scope = CancellationToken::new();
        let copies = ImageCopies::default();
        let reader = Reader {
            client: reqwest::Client::new(),
            backend: &backend,
            route_owner: "isolated-copy",
            token: "isolated-token",
            cancel: &scope,
        };
        let written = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        for _ in 0..2 {
            let written = written.clone();
            reader
                .copy_image_using(&copies, conversation, message, move |pixels| {
                    written.lock().unwrap().push(pixels.to_vec());
                    Ok(())
                })
                .await
                .unwrap();
        }
        assert_eq!(
            requests
                .iter()
                .map(|count| count.load(Ordering::SeqCst))
                .collect::<Vec<_>>(),
            vec![2, 2, 1]
        );
        let pixels = written.lock().unwrap();
        assert_eq!(pixels.len(), 2);
        assert_eq!(pixels[0], pixels[1]);
        drop(pixels);
        denied.store(true, Ordering::SeqCst);
        assert!(reader
            .copy_image_using(&copies, conversation, message, |_| panic!(
                "denied media reached clipboard"
            ))
            .await
            .is_err());
        denied.store(false, Ordering::SeqCst);
        revoked.store(true, Ordering::SeqCst);
        assert!(reader
            .copy_image_using(&copies, conversation, message, |_| panic!(
                "revoked message reached clipboard"
            ))
            .await
            .is_err());
        assert_eq!(requests[2].load(Ordering::SeqCst), 1);
        serve.abort();
    }
}
