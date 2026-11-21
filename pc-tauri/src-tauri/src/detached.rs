use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use sha2::{Digest, Sha256};

use crate::{
    archive_events::Watch,
    archive_reader::{
        copy_text, ArchiveChanges, Contact, Error, Media, Reader, WireMessage, PAGE_SIZE,
    },
    backend::Backend,
    downloads::{self, DownloadSpec, Downloads},
    http::{valid_authorization, ApiTransport},
    workspace::{conversation_window, group_id, is_workspace, trusted_page},
};

const HISTORY_REFRESH: &str = "pulse-archive-refresh";
const IMAGE_CHANGED: &str = "pulse-archive-image";
const CONVERSATION_EVENT: &str = "pulse-conversation-window-packet";
const CLOSED: &str = "此窗口已失效，请从聊天中重新打开。";
const BUSY: &str = "正在读取聊天记录，请稍候。";
const MAX_WINDOWS: usize = 16;
const MAX_KNOWN_ASSETS: usize = 3_000;

struct Session {
    lease: Uuid,
    owner: String,
    user: Uuid,
    token: Zeroizing<String>,
    cancel: CancellationToken,
}

#[derive(Deserialize)]
pub struct SessionInput {
    user: Uuid,
    token: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct HistoryInput {
    conversation: Uuid,
    title: String,
    kind: String,
    theme: String,
    #[serde(skip_serializing, rename = "eventSeq")]
    event_seq: Option<String>,
}

#[derive(Clone)]
struct ImageTarget {
    conversation: Uuid,
    message: Uuid,
    cancel: CancellationToken,
}

#[derive(Default)]
struct HistoryState {
    generation: u64,
    cursor: Option<(i64, i64)>,
    assets: HashSet<Uuid>,
    requests: CancellationToken,
}

struct HistoryWindow {
    input: HistoryInput,
    state: Mutex<HistoryState>,
    page: tokio::sync::Mutex<()>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationInput {
    conversation: Uuid,
    title: String,
    kind: String,
    theme: String,
    connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationContext {
    #[serde(flatten)]
    input: ConversationInput,
    lease: Uuid,
    #[serde(serialize_with = "serialize_secret")]
    token: Zeroizing<String>,
    user: Uuid,
}

fn serialize_secret<S: serde::Serializer>(
    secret: &Zeroizing<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(secret)
}

enum WindowContent {
    History(HistoryWindow),
    Image(Mutex<ImageTarget>),
    Conversation(ConversationInput),
}

struct ChildWindow {
    session: Arc<Session>,
    cancel: CancellationToken,
    owner: String,
    content: WindowContent,
}

impl ChildWindow {
    fn reader<'a>(&'a self, api: &'a ApiTransport, backend: &'a Backend) -> Reader<'a> {
        Reader {
            client: api.client(),
            backend,
            route_owner: &self.session.owner,
            token: &self.session.token,
            cancel: &self.cancel,
        }
    }

    fn history(&self) -> Result<&HistoryWindow, &'static str> {
        match &self.content {
            WindowContent::History(history) => Ok(history),
            _ => Err(CLOSED),
        }
    }

    fn image(&self) -> Result<ImageTarget, &'static str> {
        match &self.content {
            WindowContent::Image(image) => Ok(image.lock().map_err(|_| CLOSED)?.clone()),
            _ => Err(CLOSED),
        }
    }
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<Session>>,
    windows: HashMap<String, Arc<ChildWindow>>,
    watches: HashMap<(Uuid, Uuid), Arc<Watch>>,
    conversation_epochs: HashMap<String, u64>,
}

#[derive(Default)]
pub struct DetachedWindows {
    registry: Mutex<Registry>,
    creation: tokio::sync::Mutex<()>,
}

impl Registry {
    fn prune_watches(&mut self) {
        let open: HashSet<(Uuid, Uuid)> = self
            .windows
            .values()
            .filter_map(|child| {
                let conversation = match &child.content {
                    WindowContent::History(history) => history.input.conversation,
                    WindowContent::Image(image) => image.lock().ok()?.conversation,
                    WindowContent::Conversation(_) => return None,
                };
                Some((child.session.lease, conversation))
            })
            .collect();
        self.watches.retain(|conversation, watch| {
            let keep = open.contains(conversation);
            if !keep {
                watch.cancel.cancel();
            }
            keep
        });
    }
}

fn event_cursor(value: Option<&str>) -> Option<i64> {
    value?.parse::<i64>().ok().filter(|seq| *seq >= 0)
}

pub(crate) struct OutboxScope {
    pub owner: String,
    pub user: Uuid,
    pub conversation: Uuid,
    pub cancel: CancellationToken,
    digest: [u8; 32],
}

impl OutboxScope {
    pub(crate) fn matches(&self, window: &WebviewWindow, token: &ZeroizingString) -> bool {
        let digest: [u8; 32] = Sha256::digest(token.0.as_bytes()).into();
        window.label() == self.owner && workspace_only(window).is_ok() && digest == self.digest
    }
}

pub(crate) struct DownloadScope {
    pub owner: String,
    pub user: Uuid,
    pub token: Zeroizing<String>,
    pub cancel: CancellationToken,
}

impl DetachedWindows {
    pub(crate) fn network_owner(&self, window: &WebviewWindow) -> Result<String, &'static str> {
        if is_workspace(window.label()) {
            workspace_only(window)?;
            return Ok(window.label().to_owned());
        }
        Ok(self.window(window)?.session.owner.clone())
    }

    pub(crate) fn media_authority(
        &self,
        window: &WebviewWindow,
    ) -> Result<CancellationToken, &'static str> {
        if !is_workspace(window.label()) {
            let child = self.window(window)?;
            if child.session.cancel.is_cancelled() {
                return Err(CLOSED);
            }
            return Ok(child.cancel.clone());
        }
        workspace_only(window)?;
        self.registry
            .lock()
            .map_err(|_| CLOSED)?
            .sessions
            .get(window.label())
            .filter(|session| !session.cancel.is_cancelled())
            .map(|session| session.cancel.clone())
            .ok_or(CLOSED)
    }

    pub(crate) fn network_children(&self, owner: &str) -> Vec<String> {
        self.registry
            .lock()
            .map(|registry| {
                registry
                    .windows
                    .iter()
                    .filter(|(_, child)| {
                        child.session.owner == owner && !child.cancel.is_cancelled()
                    })
                    .map(|(label, _)| label.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn download_scope(
        &self,
        window: &WebviewWindow,
        lease: Uuid,
    ) -> Result<DownloadScope, &'static str> {
        let session = self.session(window, lease)?;
        let cancel = if conversation_window(window.label()) {
            self.window(window)?.cancel.clone()
        } else {
            session.cancel.clone()
        };
        if cancel.is_cancelled() || session.cancel.is_cancelled() {
            return Err(CLOSED);
        }
        Ok(DownloadScope {
            owner: session.owner.clone(),
            user: session.user,
            token: session.token.clone(),
            cancel,
        })
    }

    pub(crate) fn screen_capture_authority(
        &self,
        window: &WebviewWindow,
    ) -> Result<CancellationToken, &'static str> {
        if conversation_window(window.label()) {
            let child = self.window(window)?;
            if !matches!(child.content, WindowContent::Conversation(_)) {
                return Err(CLOSED);
            }
            return Ok(child.cancel.clone());
        }
        workspace_only(window)?;
        self.registry
            .lock()
            .map_err(|_| CLOSED)?
            .sessions
            .get(window.label())
            .filter(|session| !session.cancel.is_cancelled())
            .map(|session| session.cancel.clone())
            .ok_or("请先登录并打开会话。")
    }

    pub(crate) fn outbox_scope(&self, window: &WebviewWindow) -> Result<OutboxScope, &'static str> {
        let child = self.window(window)?;
        let WindowContent::Conversation(input) = &child.content else {
            return Err(CLOSED);
        };
        Ok(OutboxScope {
            owner: child.session.owner.clone(),
            user: child.session.user,
            conversation: input.conversation,
            cancel: child.cancel.clone(),
            digest: Sha256::digest(child.session.token.as_bytes()).into(),
        })
    }

    pub(crate) fn outbox_targets(
        &self,
        window: &WebviewWindow,
        token: &ZeroizingString,
        conversation: Uuid,
    ) -> Result<Vec<String>, &'static str> {
        workspace_only(window)?;
        let registry = self.registry.lock().map_err(|_| CLOSED)?;
        Ok(registry.windows.iter().filter_map(|(label, child)| {
            (child.session.owner == window.label() && *child.session.token == *token.0 &&
                !child.cancel.is_cancelled() && matches!(&child.content, WindowContent::Conversation(input) if input.conversation == conversation))
                .then(|| label.clone())
        }).collect())
    }

    pub(crate) fn credential_digest(
        &self,
        window: &WebviewWindow,
    ) -> Result<Option<[u8; 32]>, &'static str> {
        if !conversation_window(window.label()) {
            return Ok(None);
        }
        let child = self.window(window)?;
        if !matches!(child.content, WindowContent::Conversation(_)) {
            return Err(CLOSED);
        }
        Ok(Some(Sha256::digest(child.session.token.as_bytes()).into()))
    }

    fn session(&self, window: &WebviewWindow, lease: Uuid) -> Result<Arc<Session>, &'static str> {
        if conversation_window(window.label()) {
            let child = self.window(window)?;
            if matches!(child.content, WindowContent::Conversation(_))
                && child.session.lease == lease
            {
                return Ok(child.session.clone());
            }
            return Err(CLOSED);
        }
        workspace_only(window)?;
        self.registry
            .lock()
            .map_err(|_| CLOSED)?
            .sessions
            .get(window.label())
            .filter(|session| session.lease == lease && !session.cancel.is_cancelled())
            .cloned()
            .ok_or(CLOSED)
    }

    fn window(&self, window: &WebviewWindow) -> Result<Arc<ChildWindow>, &'static str> {
        if !window.url().is_ok_and(|url| trusted_page(&url)) {
            return Err(CLOSED);
        }
        self.registry
            .lock()
            .map_err(|_| CLOSED)?
            .windows
            .get(window.label())
            .filter(|child| !child.cancel.is_cancelled())
            .cloned()
            .ok_or(CLOSED)
    }

    fn add(
        &self,
        label: &str,
        child: Arc<ChildWindow>,
        conversation: Uuid,
        cursor: i64,
    ) -> Result<(), &'static str> {
        let mut registry = self.registry.lock().map_err(|_| CLOSED)?;
        if child.cancel.is_cancelled()
            || (child.owner != child.session.owner && !registry.windows.contains_key(&child.owner))
        {
            return Err(CLOSED);
        }
        if registry.windows.len() >= MAX_WINDOWS {
            return Err("独立窗口已满，请先关闭不用的窗口。");
        }
        registry
            .watches
            .entry((child.session.lease, conversation))
            .or_insert_with(|| Arc::new(Watch::new(cursor, &child.session.cancel)));
        registry.windows.insert(label.to_owned(), child);
        Ok(())
    }

    fn detach(&self, label: &str) -> Vec<String> {
        let Ok(mut registry) = self.registry.lock() else {
            return Vec::new();
        };
        if let Some(session) = registry.sessions.remove(label) {
            session.cancel.cancel();
        }
        registry.conversation_epochs.remove(label);
        let mut removing = HashSet::from([label.to_owned()]);
        loop {
            let previous = removing.len();
            let next: Vec<String> = registry
                .windows
                .iter()
                .filter_map(|(key, child)| {
                    (removing.contains(&child.session.owner) || removing.contains(&child.owner))
                        .then(|| key.clone())
                })
                .collect();
            removing.extend(next);
            if previous == removing.len() {
                break;
            }
        }
        let mut removed = Vec::new();
        registry.windows.retain(|key, child| {
            if !removing.contains(key) {
                return true;
            }
            child.cancel.cancel();
            removed.push(key.clone());
            false
        });
        registry.prune_watches();
        removed
    }

    pub fn window_destroyed(&self, app: &AppHandle, label: &str) {
        for key in self.detach(label) {
            if key != label {
                destroy(app, &key);
            }
        }
    }

    fn close(&self, app: &AppHandle, label: &str) {
        for key in self.detach(label) {
            destroy(app, &key);
        }
    }
}

fn workspace_only(window: &WebviewWindow) -> Result<(), &'static str> {
    if is_workspace(window.label()) && window.url().is_ok_and(|url| trusted_page(&url)) {
        Ok(())
    } else {
        Err(CLOSED)
    }
}

fn destroy(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
        let _ = window.destroy();
    }
}

fn show(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn build_window(
    app: &AppHandle,
    caller: &WebviewWindow,
    label: &str,
    title: &str,
    width: f64,
    height: f64,
    profile: Option<std::path::PathBuf>,
) -> Result<WebviewWindow, &'static str> {
    // Archive pages have their own WebView2 profile and only narrow commands.
    let archive_dir = crate::storage::cache(app)
        .map_err(|_| CLOSED)?
        .join("archive-webview");
    let mut window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .use_https_scheme(true)
        .title(title)
        .visible(false)
        .min_inner_size(480.0, 360.0)
        .data_directory(profile.unwrap_or(archive_dir))
        .disable_drag_drop_handler()
        .on_navigation(trusted_page)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    if let Ok(Some(monitor)) = caller.current_monitor() {
        let scale = monitor.scale_factor();
        let work = monitor.work_area();
        let work_width = f64::from(work.size.width) / scale;
        let work_height = f64::from(work.size.height) / scale;
        let width = width.min((work_width - 40.0).max(480.0));
        let height = height.min((work_height - 80.0).max(360.0));
        window = window.inner_size(width, height).position(
            f64::from(work.position.x) / scale + (work_width - width - 16.0).max(0.0),
            f64::from(work.position.y) / scale + ((work_height - height) / 2.0).max(0.0),
        );
    } else {
        window = window.inner_size(width, height).center();
    }
    window.build().map_err(|_| "无法打开独立窗口，请重试。")
}

#[tauri::command]
pub fn set_archive_session(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    input: Option<SessionInput>,
) -> Result<Option<Uuid>, &'static str> {
    workspace_only(&window)?;
    let next = input
        .map(|input| {
            if input.user.is_nil() || !valid_authorization(&format!("Bearer {}", input.token)) {
                return Err("请重新登录后打开独立窗口。");
            }
            Ok(Arc::new(Session {
                lease: Uuid::new_v4(),
                owner: window.label().to_owned(),
                user: input.user,
                token: Zeroizing::new(input.token),
                cancel: CancellationToken::new(),
            }))
        })
        .transpose()?;
    let lease = next.as_ref().map(|session| session.lease);
    let owner = window.label();
    let old = {
        let mut registry = windows.registry.lock().map_err(|_| CLOSED)?;
        let previous = registry.sessions.remove(owner).map(|session| {
            session.cancel.cancel();
            session.lease
        });
        if let Some(next) = next {
            registry.sessions.insert(owner.to_owned(), next);
        }
        let mut old = Vec::new();
        registry.windows.retain(|label, child| {
            if Some(child.session.lease) != previous {
                return true;
            }
            old.push(label.clone());
            false
        });
        registry.prune_watches();
        old
    };
    for label in old {
        destroy(&app, &label);
    }
    Ok(lease)
}

fn check_current_conversation(
    windows: &DetachedWindows,
    window: &WebviewWindow,
    conversation: Uuid,
) -> Result<(), &'static str> {
    if !conversation_window(window.label()) {
        return Ok(());
    }
    let child = windows.window(window)?;
    if matches!(&child.content, WindowContent::Conversation(input) if input.conversation == conversation)
    {
        Ok(())
    } else {
        Err("此窗口只能查看当前会话。")
    }
}

#[tauri::command]
pub async fn open_chat_window(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    api: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
    lease: Uuid,
    mut input: ConversationInput,
) -> Result<(), &'static str> {
    let current = windows.session(&window, lease)?;
    if input.conversation.is_nil() || !matches!(input.kind.as_str(), "direct" | "group" | "channel")
    {
        return Err("请选择有效会话。");
    }
    let ancestor = &current.owner;
    let epoch = windows
        .registry
        .lock()
        .map_err(|_| CLOSED)?
        .conversation_epochs
        .get(ancestor)
        .copied()
        .unwrap_or(0);
    let reader = Reader {
        client: api.client(),
        backend: &backend,
        route_owner: &current.owner,
        token: &current.token,
        cancel: &current.cancel,
    };
    reader
        .access(input.conversation)
        .await
        .map_err(|error| error.text())?;
    let _creation = windows.creation.lock().await;
    windows.session(&window, lease)?;
    let existing = {
        let registry = windows.registry.lock().map_err(|_| CLOSED)?;
        if registry
            .conversation_epochs
            .get(ancestor)
            .copied()
            .unwrap_or(0)
            != epoch
        {
            return Err(CLOSED);
        }
        registry.windows.iter().find_map(|(label, child)| {
            (child.session.owner == *ancestor && *child.session.token == *current.token && !child.cancel.is_cancelled() &&
                matches!(&child.content, WindowContent::Conversation(target) if target.conversation == input.conversation))
                .then(|| label.clone())
        })
    };
    if let Some(label) = existing {
        if let Some(view) = app.get_webview_window(&label) {
            show(&view);
            return Ok(());
        }
        windows.close(&app, &label);
    }
    input.title = input.title.trim().chars().take(120).collect();
    if input.title.is_empty() {
        input.title = "聊天".into();
    }
    let session = Arc::new(Session {
        lease: Uuid::new_v4(),
        owner: ancestor.clone(),
        user: current.user,
        token: current.token.clone(),
        cancel: CancellationToken::new(),
    });
    let label = format!("conversation-{}", Uuid::new_v4());
    let title = format!("{} · 聊天", input.title);
    let workspace_dir = if let Some(id) = group_id(ancestor) {
        crate::workspace_groups::directory(&app, id).map_err(|_| CLOSED)?
    } else {
        crate::storage::data(&app).map_err(|_| CLOSED)?
    };
    let profile = workspace_dir
        .join("conversation-webview")
        .join(session.user.to_string());
    let child = Arc::new(ChildWindow {
        cancel: session.cancel.clone(),
        session,
        owner: ancestor.clone(),
        content: WindowContent::Conversation(input),
    });
    {
        let mut registry = windows.registry.lock().map_err(|_| CLOSED)?;
        if current.cancel.is_cancelled()
            || registry
                .conversation_epochs
                .get(ancestor)
                .copied()
                .unwrap_or(0)
                != epoch
        {
            return Err(CLOSED);
        }
        if registry.windows.len() >= MAX_WINDOWS {
            return Err("独立窗口已满，请先关闭不用的窗口。");
        }
        registry.windows.insert(label.clone(), child.clone());
    }
    let view = build_window(&app, &window, &label, &title, 940.0, 740.0, Some(profile))
        .inspect_err(|_| windows.close(&app, &label))?;
    if child.cancel.is_cancelled() {
        destroy(&app, &label);
        return Err(CLOSED);
    }
    show(&view);
    Ok(())
}

#[tauri::command]
pub fn chat_window_context(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
) -> Result<ConversationContext, &'static str> {
    let child = windows.window(&window)?;
    let WindowContent::Conversation(input) = &child.content else {
        return Err(CLOSED);
    };
    Ok(ConversationContext {
        input: input.clone(),
        lease: child.session.lease,
        token: child.session.token.clone(),
        user: child.session.user,
    })
}

#[tauri::command]
pub fn close_chat_windows(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    token: Option<ZeroizingString>,
) -> Result<(), &'static str> {
    workspace_only(&window)?;
    let targets = {
        let mut registry = windows.registry.lock().map_err(|_| CLOSED)?;
        let next = registry
            .conversation_epochs
            .entry(window.label().to_owned())
            .or_default();
        *next = next.wrapping_add(1);
        registry
            .windows
            .iter()
            .filter_map(|(label, child)| {
                (child.session.owner == window.label()
                    && matches!(child.content, WindowContent::Conversation(_))
                    && token
                        .as_ref()
                        .is_none_or(|value| *value.0 == *child.session.token))
                .then(|| {
                    child.cancel.cancel();
                    label.clone()
                })
            })
            .collect::<Vec<_>>()
    };
    for target in targets {
        windows.close(&app, &target);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(from = "String")]
pub struct ZeroizingString(Zeroizing<String>);

impl From<String> for ZeroizingString {
    fn from(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct WindowPacket {
    #[serde(rename = "type")]
    kind: String,
    conversation_id: Option<Uuid>,
    event_seq: Option<String>,
    status: Option<u16>,
}

#[tauri::command]
pub fn relay_chat_window_packet(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    token: ZeroizingString,
    packet: WindowPacket,
) -> Result<(), &'static str> {
    workspace_only(&window)?;
    if packet.kind.len() > 40 || packet.event_seq.as_ref().is_some_and(|seq| seq.len() > 20) {
        return Ok(());
    }
    let targets = {
        let registry = windows.registry.lock().map_err(|_| CLOSED)?;
        registry
            .windows
            .iter()
            .filter_map(|(label, child)| {
                let WindowContent::Conversation(input) = &child.content else {
                    return None;
                };
                (child.session.owner == window.label()
                    && *child.session.token == *token.0
                    && !child.cancel.is_cancelled()
                    && packet
                        .conversation_id
                        .is_none_or(|cid| input.conversation == cid))
                .then(|| label.clone())
            })
            .collect::<Vec<_>>()
    };
    for target in targets {
        let _ = app.emit_to(target, CONVERSATION_EVENT, &packet);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_archive_history(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    lease: Uuid,
    mut input: HistoryInput,
) -> Result<(), &'static str> {
    let _creation = windows.creation.lock().await;
    let session = windows.session(&window, lease)?;
    if !matches!(
        input.kind.as_str(),
        "direct" | "group" | "channel" | "favorites"
    ) || input.conversation.is_nil()
    {
        return Err("请选择有效会话后查看聊天记录。");
    }
    let existing = {
        let registry = windows.registry.lock().map_err(|_| CLOSED)?;
        registry.windows.iter().find_map(|(label, child)| {
            (child.session.lease == lease
                && child.owner == window.label()
                && child
                    .history()
                    .is_ok_and(|history| history.input.conversation == input.conversation))
            .then(|| label.clone())
        })
    };
    if let Some(label) = existing {
        if let Some(view) = app.get_webview_window(&label) {
            if !session.cancel.is_cancelled() {
                show(&view);
            }
            return Ok(());
        }
        windows.close(&app, &label);
    }
    input.title = input.title.trim().chars().take(120).collect();
    if input.title.is_empty() {
        input.title = "当前会话".into();
    }
    if !matches!(input.theme.as_str(), "night" | "day" | "color" | "classic") {
        input.theme = "classic".into();
    }
    let title = format!("{} · 聊天记录", input.title);
    let conversation = input.conversation;
    check_current_conversation(&windows, &window, conversation)?;
    let cursor = event_cursor(input.event_seq.as_deref()).unwrap_or(0);
    let cancel = session.cancel.child_token();
    let requests = cancel.child_token();
    let child = Arc::new(ChildWindow {
        cancel,
        session,
        owner: window.label().to_owned(),
        content: WindowContent::History(HistoryWindow {
            input,
            state: Mutex::new(HistoryState {
                requests,
                ..HistoryState::default()
            }),
            page: tokio::sync::Mutex::new(()),
        }),
    });
    let label = format!("history-{}", Uuid::new_v4());
    windows.add(&label, child.clone(), conversation, cursor)?;
    let view = build_window(&app, &window, &label, &title, 660.0, 760.0, None)
        .inspect_err(|_| windows.close(&app, &label))?;
    if child.cancel.is_cancelled() {
        destroy(&app, &label);
        return Err(CLOSED);
    }
    show(&view);
    Ok(())
}

#[tauri::command]
pub fn archive_history_context(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
) -> Result<HistoryInput, &'static str> {
    let child = windows.window(&window)?;
    Ok(child.history()?.input.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryMessage {
    id: Uuid,
    seq: String,
    name: String,
    avatar: Option<Uuid>,
    mine: bool,
    kind: String,
    text: String,
    created_at: String,
    media: Option<Media>,
    contact: Option<Contact>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    items: Vec<HistoryMessage>,
    has_more: bool,
}

#[tauri::command]
pub async fn archive_history_page(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    api: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
    older: bool,
) -> Result<HistoryPage, &'static str> {
    let child = windows.window(&window)?;
    let history = child.history()?;
    let _page = history.page.try_lock().map_err(|_| BUSY)?;
    let (generation, before, version, requests) = {
        let state = history.state.lock().map_err(|_| CLOSED)?;
        let (before, version) = if older {
            let Some((before, version)) = state.cursor else {
                return Ok(HistoryPage {
                    items: Vec::new(),
                    has_more: false,
                });
            };
            (Some(before), Some(version))
        } else {
            (None, None)
        };
        (state.generation, before, version, state.requests.clone())
    };
    let conversation = history.input.conversation;
    let reader = Reader {
        cancel: &requests,
        ..child.reader(&api, &backend)
    };
    let response = reader
        .page(conversation, before, version)
        .await
        .map_err(|error| {
            if error.closes_history() {
                windows.close(&app, window.label());
            }
            error.text()
        })?;
    let version = response
        .membership_version
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or(Error::Invalid.text())?;
    if response.items.len() > PAGE_SIZE {
        return Err(Error::Invalid.text());
    }
    let mut last = before.unwrap_or(i64::MAX);
    let mut items = Vec::with_capacity(response.items.len());
    let mut assets = HashSet::new();
    for row in response.items {
        let sequence: i64 = row.seq.parse().map_err(|_| Error::Invalid.text())?;
        if row.conversation_id != conversation
            || row.revoked
            || sequence < 1
            || sequence > last
            || (!items.is_empty() && sequence == last)
        {
            return Err(Error::Invalid.text());
        }
        last = sequence;
        let content = row.content.unwrap_or_default();
        let (name, avatar) = row
            .sender
            .map(|sender| (sender.name, sender.avatar_id))
            .unwrap_or_else(|| ("会话成员".into(), None));
        assets.extend(avatar);
        assets.extend(content.media.as_ref().map(|media| media.id));
        items.push(HistoryMessage {
            id: row.id,
            seq: row.seq,
            name,
            avatar,
            mine: row.sender_id == child.session.user,
            kind: row.kind,
            text: row.body,
            created_at: row.created_at,
            media: content.media,
            contact: content.contact,
        });
    }
    let has_more = response.has_more && !items.is_empty() && last > 1;
    let mut state = history.state.lock().map_err(|_| CLOSED)?;
    if child.cancel.is_cancelled() || state.generation != generation {
        return Err(Error::Cancelled.text());
    }
    if !older || state.assets.len() + assets.len() > MAX_KNOWN_ASSETS {
        state.assets.clear();
    }
    state.assets.extend(assets);
    state.cursor = has_more.then(|| (last - 1, version));
    items.reverse();
    Ok(HistoryPage { items, has_more })
}

#[tauri::command]
pub async fn archive_history_assets(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    api: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
    ids: Vec<Uuid>,
) -> Result<HashMap<Uuid, String>, &'static str> {
    if ids.len() > PAGE_SIZE * 2 {
        return Err(Error::Invalid.text());
    }
    let child = windows.window(&window)?;
    let history = child.history()?;
    let (generation, requests) = {
        let state = history.state.lock().map_err(|_| CLOSED)?;
        if ids.iter().any(|id| !state.assets.contains(id)) {
            return Err(CLOSED);
        }
        (state.generation, state.requests.clone())
    };
    let reader = Reader {
        cancel: &requests,
        ..child.reader(&api, &backend)
    };
    let result = reader.assets(&ids).await.map_err(|error| error.text())?;
    if child.cancel.is_cancelled()
        || generation != history.state.lock().map_err(|_| CLOSED)?.generation
    {
        return Err(CLOSED);
    }
    Ok(result)
}

async fn checked_history_message(
    child: &ChildWindow,
    api: &ApiTransport,
    backend: &Backend,
    id: Uuid,
) -> Result<WireMessage, &'static str> {
    let conversation = child.history()?.input.conversation;
    child
        .reader(api, backend)
        .message(conversation, id)
        .await
        .map_err(|error| error.text())
}

#[tauri::command]
pub async fn archive_copy_text(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    api: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
    message: Uuid,
) -> Result<(), &'static str> {
    let child = windows.window(&window)?;
    let row = checked_history_message(&child, &api, &backend, message).await?;
    if row.body.is_empty() {
        return Err("这条消息没有可复制的文字。");
    }
    copy_text(row.body, child.cancel.clone()).await
}

#[tauri::command]
pub async fn archive_download_file(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    api: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
    downloads: State<'_, Downloads>,
    message: Uuid,
) -> Result<bool, &'static str> {
    let child = windows.window(&window)?;
    let row = checked_history_message(&child, &api, &backend, message).await?;
    if row.kind != "file" {
        return Err("这条消息没有可下载的文件。");
    }
    let prefs = downloads
        .preferences(&child.session.owner, child.session.user)
        .await;
    if child.cancel.is_cancelled() {
        return Err(CLOSED);
    }
    let Some(directory) = downloads::pick_directory(app.clone(), window, prefs.directory).await?
    else {
        return Ok(false);
    };
    let row = checked_history_message(&child, &api, &backend, message).await?;
    let media = row
        .content
        .and_then(|content| content.media)
        .ok_or("这条消息没有可下载的文件。")?;
    if child.cancel.is_cancelled() {
        return Err(CLOSED);
    }
    let owner = app.get_webview_window(&child.session.owner).ok_or(CLOSED)?;
    downloads::start_in_directory(
        &owner,
        &backend,
        &downloads,
        api.client(),
        DownloadSpec {
            media_id: media.id,
            name: media.filename,
            token: child.session.token.to_string(),
        },
        directory,
        child.session.cancel.child_token(),
    )?;
    Ok(true)
}

#[tauri::command]
pub async fn open_archive_image(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    api: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
    lease: Option<Uuid>,
    conversation: Option<Uuid>,
    event_seq: Option<String>,
    message: Uuid,
) -> Result<(), &'static str> {
    let (session, conversation, owner_cancel) =
        if is_workspace(window.label()) || conversation_window(window.label()) {
            let session = windows.session(&window, lease.ok_or(CLOSED)?)?;
            let cancel = session.cancel.clone();
            (session, conversation.ok_or(CLOSED)?, cancel)
        } else {
            let child = windows.window(&window)?;
            (
                child.session.clone(),
                child.history()?.input.conversation,
                child.cancel.clone(),
            )
        };
    check_current_conversation(&windows, &window, conversation)?;
    let reader = Reader {
        client: api.client(),
        backend: &backend,
        route_owner: &session.owner,
        token: &session.token,
        cancel: &owner_cancel,
    };
    let row = reader
        .message(conversation, message)
        .await
        .map_err(|error| error.text())?;
    if row.kind != "image"
        || row
            .content
            .as_ref()
            .and_then(|content| content.media.as_ref())
            .is_none()
    {
        return Err("这条消息没有可预览的图片。");
    }
    let _creation = windows.creation.lock().await;
    if owner_cancel.is_cancelled() {
        return Err(CLOSED);
    }
    let existing = {
        let registry = windows.registry.lock().map_err(|_| CLOSED)?;
        registry.windows.iter().find_map(|(label, child)| {
            (child.session.lease == session.lease
                && child.owner == window.label()
                && matches!(child.content, WindowContent::Image(_)))
            .then(|| (label.clone(), child.clone()))
        })
    };
    if let Some((label, child)) = existing {
        if let Some(view) = app.get_webview_window(&label) {
            if let WindowContent::Image(image) = &child.content {
                let mut current = image.lock().map_err(|_| CLOSED)?;
                if current.conversation != conversation || current.message != message {
                    current.cancel.cancel();
                    *current = ImageTarget {
                        conversation,
                        message,
                        cancel: child.cancel.child_token(),
                    };
                    drop(current);
                    {
                        let mut registry = windows.registry.lock().map_err(|_| CLOSED)?;
                        if child.cancel.is_cancelled() || !registry.windows.contains_key(&label) {
                            return Err(CLOSED);
                        }
                        registry
                            .watches
                            .entry((session.lease, conversation))
                            .or_insert_with(|| {
                                Arc::new(Watch::new(
                                    event_cursor(event_seq.as_deref()).unwrap_or(0),
                                    &session.cancel,
                                ))
                            });
                        registry.prune_watches();
                    }
                    let _ = app.emit_to(&label, IMAGE_CHANGED, ());
                }
            }
            if !child.cancel.is_cancelled() {
                show(&view);
            }
            return Ok(());
        }
        windows.close(&app, &label);
    }
    let cancel = owner_cancel.child_token();
    let child = Arc::new(ChildWindow {
        content: WindowContent::Image(Mutex::new(ImageTarget {
            conversation,
            message,
            cancel: cancel.child_token(),
        })),
        cancel,
        session,
        owner: window.label().to_owned(),
    });
    let label = format!("image-{}", Uuid::new_v4());
    windows.add(
        &label,
        child.clone(),
        conversation,
        event_cursor(event_seq.as_deref()).unwrap_or(0),
    )?;
    let view = build_window(&app, &window, &label, "图片预览", 920.0, 760.0, None)
        .inspect_err(|_| windows.close(&app, &label))?;
    if child.cancel.is_cancelled() {
        destroy(&app, &label);
        return Err(CLOSED);
    }
    show(&view);
    Ok(())
}

#[derive(Serialize)]
pub struct ArchiveImage {
    name: String,
    url: String,
}

#[tauri::command]
pub async fn archive_image(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    api: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
) -> Result<ArchiveImage, &'static str> {
    let child = windows.window(&window)?;
    let target = child.image()?;
    let reader = Reader {
        cancel: &target.cancel,
        ..child.reader(&api, &backend)
    };
    let (media, url) = reader
        .image(target.conversation, target.message)
        .await
        .map_err(|error| error.text())?;
    if target.cancel.is_cancelled() {
        return Err(CLOSED);
    }
    Ok(ArchiveImage {
        name: media.filename,
        url: url.into(),
    })
}

#[tauri::command]
pub async fn copy_conversation_image(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    api: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
    lease: Uuid,
    conversation: Uuid,
    message: Uuid,
) -> Result<(), &'static str> {
    let session = windows.session(&window, lease)?;
    check_current_conversation(&windows, &window, conversation)?;
    let cancel = if conversation_window(window.label()) {
        windows.window(&window)?.cancel.clone()
    } else {
        session.cancel.clone()
    };
    let reader = Reader {
        client: api.client(),
        backend: &backend,
        route_owner: &session.owner,
        token: &session.token,
        cancel: &cancel,
    };
    reader.copy_image(conversation, message).await
}

#[tauri::command]
pub async fn archive_copy_image(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    api: State<'_, ApiTransport>,
    backend: State<'_, Backend>,
    message: Option<Uuid>,
) -> Result<(), &'static str> {
    let child = windows.window(&window)?;
    if let Some(message) = message {
        let conversation = child.history()?.input.conversation;
        child
            .reader(&api, &backend)
            .copy_image(conversation, message)
            .await
    } else {
        let target = child.image()?;
        let reader = Reader {
            cancel: &target.cancel,
            ..child.reader(&api, &backend)
        };
        reader.copy_image(target.conversation, target.message).await
    }
}

#[tauri::command]
pub fn close_archive_window(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
) -> Result<(), &'static str> {
    windows.window(&window)?;
    windows.close(&app, window.label());
    Ok(())
}

#[derive(Clone, Serialize)]
struct ArchiveUpdate {
    reload: bool,
    removed: Vec<Uuid>,
}

fn update_open_windows(
    app: &AppHandle,
    windows: &DetachedWindows,
    session: &Session,
    conversation: Option<Uuid>,
    change: ArchiveChanges,
) -> Result<(), &'static str> {
    if session.cancel.is_cancelled() || (!change.reload && change.removed.is_empty()) {
        return Ok(());
    }
    let (refresh, close) = {
        let registry = windows.registry.lock().map_err(|_| CLOSED)?;
        let mut refresh = Vec::new();
        let mut close = Vec::new();
        for (label, child) in &registry.windows {
            if child.session.lease != session.lease {
                continue;
            }
            match &child.content {
                WindowContent::History(history)
                    if conversation.is_none_or(|cid| cid == history.input.conversation) =>
                {
                    if change.reload {
                        let mut state = history.state.lock().map_err(|_| CLOSED)?;
                        state.generation += 1;
                        state.cursor = None;
                        state.assets.clear();
                        state.requests.cancel();
                        state.requests = child.cancel.child_token();
                    }
                    refresh.push(label.clone());
                }
                WindowContent::Image(image)
                    if image.lock().is_ok_and(|target| {
                        conversation.is_none_or(|cid| cid == target.conversation)
                            && (change.reload || change.removed.contains(&target.message))
                    }) =>
                {
                    child.cancel.cancel();
                    close.push(label.clone());
                }
                _ => {}
            }
        }
        (refresh, close)
    };
    for label in close {
        windows.close(app, &label);
    }
    let update = ArchiveUpdate {
        reload: change.reload,
        removed: change.removed,
    };
    for label in refresh {
        let _ = app.emit_to(label, HISTORY_REFRESH, &update);
    }
    Ok(())
}

#[tauri::command]
pub fn invalidate_archive(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    lease: Uuid,
    conversation: Option<Uuid>,
) -> Result<(), &'static str> {
    let session = windows.session(&window, lease)?;
    update_open_windows(
        &app,
        &windows,
        &session,
        conversation,
        ArchiveChanges {
            reload: true,
            removed: Vec::new(),
        },
    )
}

#[tauri::command]
pub fn observe_archive_event(
    app: AppHandle,
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    lease: Uuid,
    conversation: Uuid,
    through: String,
) -> Result<(), &'static str> {
    let session = windows.session(&window, lease)?;
    let target = event_cursor(Some(&through)).ok_or(CLOSED)?;
    let watch = windows
        .registry
        .lock()
        .map_err(|_| CLOSED)?
        .watches
        .get(&(lease, conversation))
        .cloned();
    let Some(watch) = watch.filter(|watch| watch.hint(target)) else {
        return Ok(());
    };
    tauri::async_runtime::spawn(async move {
        let api = app.state::<ApiTransport>();
        let backend = app.state::<Backend>();
        let windows = app.state::<DetachedWindows>();
        let reader = Reader {
            client: api.client(),
            backend: &backend,
            route_owner: &session.owner,
            token: &session.token,
            cancel: &watch.cancel,
        };
        // The websocket carries the high water mark, not the actual message operation.
        while let Some((after, through)) = watch.next() {
            let changes = reader.changes(conversation, after, through).await;
            if watch.cancel.is_cancelled() {
                break;
            }
            let update = changes.unwrap_or_else(|_| ArchiveChanges {
                reload: true,
                removed: Vec::new(),
            });
            let _ = update_open_windows(&app, &windows, &session, Some(conversation), update);
            watch.finish(through);
        }
    });
    Ok(())
}
