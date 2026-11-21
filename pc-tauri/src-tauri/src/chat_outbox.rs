use std::{collections::HashMap, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::detached::{DetachedWindows, OutboxScope, ZeroizingString};

const REQUEST_EVENT: &str = "pulse-chat-outbox-request";
const STATUS_EVENT: &str = "pulse-chat-outbox-status";
const UNAVAILABLE: &str = "无法连接账号的发送队列，请重试。";
const CLOSED: &str = "当前会话窗口已关闭。";
const CAPACITY: usize = 64;

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    List,
    Send {
        request_id: String,
        body: serde_json::Value,
    },
    Retry {
        id: String,
    },
    Discard {
        id: String,
    },
}

impl Action {
    fn validate(&self) -> bool {
        fn valid_id(id: &str) -> bool {
            id.strip_prefix("text-")
                .is_some_and(|uuid| Uuid::parse_str(uuid).is_ok())
        }
        match self {
            Self::List => true,
            Self::Send { request_id, body } => {
                valid_id(request_id)
                    && body
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty())
                    && serde_json::to_string(body).is_ok_and(|json| json.len() <= 256 * 1024)
            }
            Self::Retry { id } | Self::Discard { id } => valid_id(id),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Pending {
    id: String,
    status: String,
    error: String,
    text: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Snapshot {
    version: u64,
    items: Vec<Pending>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    request: Uuid,
    snapshot: Option<Snapshot>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
struct Request {
    request: Uuid,
    user: Uuid,
    conversation: Uuid,
    action: Action,
}

type Answer = Result<Snapshot, String>;

struct Waiting {
    scope: OutboxScope,
    completion: oneshot::Sender<Answer>,
}

#[derive(Default)]
pub struct ChatOutbox(Mutex<HashMap<Uuid, Waiting>>);

#[tauri::command]
pub async fn chat_outbox_action(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    outbox: State<'_, ChatOutbox>,
    action: Action,
) -> Answer {
    let scope = windows.outbox_scope(&window)?;
    if !action.validate() {
        return Err("待发送消息格式无效。".into());
    }
    let id = Uuid::new_v4();
    let (completion, answered) = oneshot::channel();
    let request = Request {
        request: id,
        user: scope.user,
        conversation: scope.conversation,
        action,
    };
    let cancel = scope.cancel.clone();
    let owner = scope.owner.clone();
    {
        let mut waiting = outbox.0.lock().map_err(|_| UNAVAILABLE)?;
        if waiting.len() >= CAPACITY {
            return Err("待发送操作较多，请稍后重试。".into());
        }
        waiting.insert(id, Waiting { scope, completion });
    }
    let result = match app.emit_to(&owner, REQUEST_EVENT, &request) {
        Ok(()) => tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(CLOSED.into()),
            result = tokio::time::timeout(Duration::from_secs(6), answered) =>
                result.ok().and_then(Result::ok).unwrap_or_else(|| Err(UNAVAILABLE.into())),
        },
        Err(_) => Err(UNAVAILABLE.into()),
    };
    if let Ok(mut waiting) = outbox.0.lock() {
        waiting.remove(&id);
    }
    result
}

#[tauri::command]
pub fn reply_chat_outbox(
    window: WebviewWindow,
    outbox: State<'_, ChatOutbox>,
    token: ZeroizingString,
    reply: Reply,
) -> Result<bool, &'static str> {
    let mut waiting = outbox.0.lock().map_err(|_| UNAVAILABLE)?;
    let Some(target) = waiting.get(&reply.request) else {
        return Ok(false);
    };
    if !target.scope.matches(&window, &token) {
        return Err(UNAVAILABLE);
    }
    let target = waiting.remove(&reply.request).ok_or(UNAVAILABLE)?;
    let result = reply
        .snapshot
        .ok_or_else(|| reply.error.unwrap_or_else(|| UNAVAILABLE.into()));
    Ok(target.completion.send(result).is_ok())
}

#[tauri::command]
pub fn publish_chat_outbox(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    token: ZeroizingString,
    conversation: Uuid,
    snapshot: Snapshot,
) -> Result<bool, &'static str> {
    let targets = windows.outbox_targets(&window, &token, conversation)?;
    for target in &targets {
        let _ = app.emit_to(target, STATUS_EVENT, &snapshot);
    }
    Ok(!targets.is_empty())
}
