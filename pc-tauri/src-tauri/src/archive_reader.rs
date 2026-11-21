use std::{collections::HashMap, time::Duration};

use reqwest::StatusCode;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::Url;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{backend::Backend, http::read_response};

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

    pub async fn copy_image(&self, conversation: Uuid, id: Uuid) -> Result<(), &'static str> {
        let (_, url) = self
            .image(conversation, id)
            .await
            .map_err(|error| error.text())?;
        let bytes = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err("图片预览已关闭。"),
            result = self.read_image(url) => result?,
        };
        let cancel = self.cancel.clone();
        tauri::async_runtime::spawn_blocking(move || copy_image(bytes, cancel))
            .await
            .map_err(|_| "无法复制图片。")?
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
fn copy_image(bytes: Vec<u8>, cancel: CancellationToken) -> Result<(), &'static str> {
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
    clipboard_win::set_clipboard(clipboard_win::formats::Bitmap, bitmap.into_inner())
        .map_err(|_| "无法写入图片到剪贴板，请重试。")
}

#[cfg(not(windows))]
fn copy_image(_bytes: Vec<u8>, _cancel: CancellationToken) -> Result<(), &'static str> {
    Err("此系统暂不支持复制图片。")
}
