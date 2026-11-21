use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use uuid::{Uuid, Version};

use crate::workspace::{group_id, is_workspace, show, trusted_page};

const GROUP_LIMIT: usize = 32;
const GROUPS_ERROR: &str = "无法读取本机的账号窗口。";
const IMPORT_ERROR: &str = "无法读取旧版账号窗口备份。请确认选择了 account-profiles.json。";
const OPEN_ERROR: &str = "无法打开独立窗口，请重试。";

#[derive(Clone, Deserialize, Serialize)]
struct SavedGroup {
    id: Uuid,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    id: Uuid,
    title: String,
    opened: bool,
    current: bool,
}

pub struct WorkspaceGroups {
    file: PathBuf,
    groups: Mutex<Vec<SavedGroup>>,
    opening: tokio::sync::Mutex<()>,
    last_focused: Mutex<String>,
}

impl WorkspaceGroups {
    pub fn load(app: &AppHandle) -> Self {
        let file = crate::storage::data(app)
            .map(|root| root.join("workspace-groups-v1.json"))
            .unwrap_or_default();
        let groups = if file.as_os_str().is_empty() {
            Vec::new()
        } else {
            read_groups(&file).unwrap_or_default()
        };
        Self {
            file,
            groups: Mutex::new(groups),
            opening: tokio::sync::Mutex::new(()),
            last_focused: Mutex::new("main".into()),
        }
    }

    pub(crate) fn window_name(&self, label: &str) -> String {
        let Some(id) = group_id(label) else {
            return "主窗口".into();
        };
        self.groups
            .lock()
            .ok()
            .and_then(|groups| {
                groups
                    .iter()
                    .find(|group| group.id == id)
                    .map(|group| group.title.clone())
            })
            .unwrap_or_else(|| "独立窗口".into())
    }

    pub fn mark_focused(&self, label: &str) {
        if is_workspace(label) {
            if let Ok(mut last) = self.last_focused.lock() {
                *last = label.to_owned();
            }
        }
    }

    pub fn recent_window(&self, app: &AppHandle) -> Option<WebviewWindow> {
        self.last_focused
            .lock()
            .ok()
            .and_then(|label| app.get_webview_window(&label))
            .or_else(|| crate::workspace::ensure_primary(app).ok())
    }

    pub fn focus_recent(&self, app: &AppHandle) {
        if let Some(window) = self.recent_window(app) {
            show(&window);
        }
    }
}

fn read_groups(file: &Path) -> Result<Vec<SavedGroup>, &'static str> {
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(GROUPS_ERROR),
    };
    if bytes.len() > 64 * 1024 {
        return Err(GROUPS_ERROR);
    }
    let mut groups: Vec<SavedGroup> = serde_json::from_slice(&bytes).map_err(|_| GROUPS_ERROR)?;
    let mut ids = std::collections::HashSet::new();
    groups.retain(|group| !group.id.is_nil() && ids.insert(group.id));
    groups.truncate(GROUP_LIMIT);
    Ok(groups)
}

fn save_groups(file: &Path, groups: &[SavedGroup]) -> Result<(), &'static str> {
    let parent = file
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or(GROUPS_ERROR)?;
    fs::create_dir_all(parent).map_err(|_| GROUPS_ERROR)?;
    let bytes = serde_json::to_vec(groups).map_err(|_| GROUPS_ERROR)?;
    let pending = parent.join(format!("workspace-groups-{}.tmp", Uuid::new_v4()));
    let result = fs::write(&pending, bytes).and_then(|_| fs::rename(&pending, file));
    if result.is_err() {
        let _ = fs::remove_file(pending);
        return Err(GROUPS_ERROR);
    }
    Ok(())
}

fn workspace_only(window: &WebviewWindow) -> Result<(), &'static str> {
    if is_workspace(window.label()) && window.url().is_ok_and(|url| trusted_page(&url)) {
        Ok(())
    } else {
        Err(OPEN_ERROR)
    }
}

fn label(id: Uuid) -> String {
    format!("workspace-{id}")
}

pub(crate) fn directory(app: &AppHandle, id: Uuid) -> tauri::Result<PathBuf> {
    Ok(crate::storage::data(app)?
        .join("workspace-groups")
        .join(id.to_string()))
}

fn open(
    app: &AppHandle,
    group: &SavedGroup,
    skip_taskbar: bool,
) -> Result<WebviewWindow, &'static str> {
    let label = label(group.id);
    if let Some(window) = app.get_webview_window(&label) {
        return Ok(window);
    }
    let data = directory(app, group.id)
        .map_err(|_| OPEN_ERROR)?
        .join("webview");
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(format!("{} · Pulse IM", group.title))
        .inner_size(1180.0, 760.0)
        .min_inner_size(740.0, 560.0)
        .center()
        .visible(false)
        .use_https_scheme(true)
        .skip_taskbar(skip_taskbar)
        .data_directory(data)
        .disable_drag_drop_handler()
        .on_navigation(trusted_page)
        .on_page_load(crate::workspace::clear_reloaded_workspace)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|_| OPEN_ERROR)
}

#[tauri::command]
pub fn list_workspace_groups(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkspaceGroups>,
) -> Result<Vec<WorkspaceInfo>, &'static str> {
    workspace_only(&window)?;
    let groups = state.groups.lock().map_err(|_| GROUPS_ERROR)?;
    Ok(groups
        .iter()
        .map(|group| {
            let name = label(group.id);
            WorkspaceInfo {
                id: group.id,
                title: group.title.clone(),
                opened: app
                    .get_webview_window(&name)
                    .is_some_and(|view| view.is_visible().unwrap_or(false)),
                current: window.label() == name,
            }
        })
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWindow {
    id: String,
    active_profile_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProfile {
    id: String,
    group_id: String,
    account: Option<LegacyAccount>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAccount {
    display_name: String,
}

#[derive(Deserialize)]
struct LegacyWorkspaceRegistry {
    version: u8,
    groups: Vec<LegacyWindow>,
    profiles: Vec<LegacyProfile>,
}

fn read_legacy_groups(path: &Path) -> Result<Vec<SavedGroup>, &'static str> {
    const LIMIT: usize = 512 * 1024;
    let metadata = fs::symlink_metadata(path).map_err(|_| IMPORT_ERROR)?;
    if metadata.is_symlink() || !metadata.is_file() {
        return Err(IMPORT_ERROR);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| IMPORT_ERROR)?
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| IMPORT_ERROR)?;
    if bytes.len() > LIMIT {
        return Err(IMPORT_ERROR);
    }
    let registry: LegacyWorkspaceRegistry =
        serde_json::from_slice(&bytes).map_err(|_| IMPORT_ERROR)?;
    if registry.version != 2 {
        return Err(IMPORT_ERROR);
    }
    let mut ids = HashSet::new();
    let profiles: HashMap<_, _> = registry
        .profiles
        .iter()
        .map(|profile| (profile.id.as_str(), profile))
        .collect();
    let mut output = Vec::new();
    for group in &registry.groups {
        if group.id == "default" {
            continue;
        }
        let id = Uuid::parse_str(&group.id).map_err(|_| IMPORT_ERROR)?;
        if id.get_version() != Some(Version::Random) || !ids.insert(id) {
            return Err(IMPORT_ERROR);
        }
        let name: String = group
            .active_profile_id
            .as_deref()
            .and_then(|id| profiles.get(id))
            .filter(|profile| profile.group_id == group.id)
            .and_then(|profile| profile.account.as_ref())
            .map(|account| {
                account
                    .display_name
                    .trim()
                    .chars()
                    .filter(|ch| {
                        !ch.is_control()
                            && !matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                    })
                    .take(48)
                    .collect()
            })
            .unwrap_or_default();
        let title = if name.trim().is_empty() {
            format!("旧版窗口 {}", output.len() + 1)
        } else {
            format!("旧版窗口 · {name}")
        };
        output.push(SavedGroup { id, title });
    }
    Ok(output)
}

#[tauri::command]
pub async fn import_legacy_workspace_groups(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkspaceGroups>,
) -> Result<Option<usize>, &'static str> {
    workspace_only(&window)?;
    let (ready, file) = oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("选择旧版账号窗口备份")
        .add_filter("账号窗口备份", &["json"])
        .pick_file(move |selected| {
            let _ = ready.send(selected);
        });
    let Some(selected) = file.await.map_err(|_| IMPORT_ERROR)? else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| IMPORT_ERROR)?;
    if path.file_name().and_then(|name| name.to_str()) != Some("account-profiles.json") {
        return Err(IMPORT_ERROR);
    }
    let imported = tauri::async_runtime::spawn_blocking(move || read_legacy_groups(&path))
        .await
        .map_err(|_| IMPORT_ERROR)??;
    workspace_only(&window)?;
    let _serial = state.opening.lock().await;
    let mut next = state.groups.lock().map_err(|_| GROUPS_ERROR)?.clone();
    let before = next.len();
    let existing: HashSet<_> = next.iter().map(|group| group.id).collect();
    next.extend(
        imported
            .into_iter()
            .filter(|group| !existing.contains(&group.id)),
    );
    let added = next.len() - before;
    if added == 0 {
        return Ok(Some(0));
    }
    if next.len() > GROUP_LIMIT {
        return Err("导入后会超过 32 个独立窗口，请减少旧版备份里的窗口数。");
    }
    let destination = state.file.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        save_groups(&destination, &next)?;
        Ok::<_, &'static str>(next)
    })
    .await
    .map_err(|_| GROUPS_ERROR)??;
    *state.groups.lock().map_err(|_| GROUPS_ERROR)? = saved;
    Ok(Some(added))
}

#[tauri::command]
pub async fn open_workspace_group(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkspaceGroups>,
    group: Option<Uuid>,
) -> Result<(), &'static str> {
    workspace_only(&window)?;
    open_group(&app, &state, group).await
}

pub async fn open_group(
    app: &AppHandle,
    state: &WorkspaceGroups,
    group: Option<Uuid>,
) -> Result<(), &'static str> {
    let _serial = state.opening.lock().await;
    let (selected, new_groups) = {
        let groups = state.groups.lock().map_err(|_| GROUPS_ERROR)?;
        if let Some(id) = group {
            (
                groups
                    .iter()
                    .find(|group| group.id == id)
                    .cloned()
                    .ok_or(OPEN_ERROR)?,
                None,
            )
        } else {
            if groups.len() >= GROUP_LIMIT {
                return Err("独立窗口数量已达上限。");
            }
            let new = SavedGroup {
                id: Uuid::new_v4(),
                title: format!("独立窗口 {}", groups.len() + 1),
            };
            let mut next = groups.clone();
            next.push(new.clone());
            (new, Some(next))
        }
    };
    let skip = app
        .state::<crate::system_settings::SystemSettings>()
        .skip_taskbar()
        .await;
    let view = open(app, &selected, skip)?;
    if let Some(groups) = new_groups {
        let file = state.file.clone();
        let saved = tauri::async_runtime::spawn_blocking(move || {
            save_groups(&file, &groups)?;
            Ok::<_, &'static str>(groups)
        })
        .await;
        match saved {
            Ok(Ok(groups)) => {
                *state.groups.lock().map_err(|_| GROUPS_ERROR)? = groups;
            }
            _ => {
                let _ = view.destroy();
                return Err(GROUPS_ERROR);
            }
        }
    }
    show(&view);
    state.mark_focused(view.label());
    Ok(())
}

#[tauri::command]
pub fn focus_primary_workspace(app: AppHandle, window: WebviewWindow) -> Result<(), &'static str> {
    workspace_only(&window)?;
    if group_id(window.label()).is_none() {
        return Ok(());
    }
    let primary = crate::workspace::ensure_primary(&app).map_err(|_| OPEN_ERROR)?;
    show(&primary);
    Ok(())
}
