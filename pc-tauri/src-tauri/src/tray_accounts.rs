use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, State, WebviewWindow,
};
use uuid::Uuid;

use crate::{
    workspace::{self, is_workspace, trusted_page},
    workspace_groups::{open_group, WorkspaceGroups},
};

const EVENT: &str = "pulse-tray-account-action";
const MENU_ERROR: &str = "无法更新 Windows 托盘菜单。";
const ROW_LIMIT: usize = 32;

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrayAccount {
    id: u64,
    revision: Uuid,
    name: String,
    active: bool,
    signed_in: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct WindowAccounts {
    owner: String,
    locked: bool,
    rows: Vec<TrayAccount>,
}

#[derive(Default)]
pub struct TrayAccounts(Mutex<HashMap<String, WindowAccounts>>);

impl TrayAccounts {
    pub fn remove_window(&self, app: &AppHandle, label: &str) {
        if !is_workspace(label) {
            return;
        }
        let removed = self
            .0
            .lock()
            .is_ok_and(|mut values| values.remove(label).is_some());
        if removed {
            let _ = self.refresh(app);
        }
    }

    fn refresh(&self, app: &AppHandle) -> Result<(), &'static str> {
        let Some(tray) = app.tray_by_id("workspace") else {
            return Ok(());
        };
        let mut windows: Vec<_> = self
            .0
            .lock()
            .map_err(|_| MENU_ERROR)?
            .values()
            .cloned()
            .collect();
        windows.sort_unstable_by(|a, b| a.owner.cmp(&b.owner));
        let menu = menu(app, &windows).map_err(|_| MENU_ERROR)?;
        tray.set_menu(Some(menu)).map_err(|_| MENU_ERROR)
    }
}

#[tauri::command]
pub fn sync_tray_accounts(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, TrayAccounts>,
    locked: bool,
    mut rows: Vec<TrayAccount>,
) -> Result<(), &'static str> {
    let label = window.label();
    if !is_workspace(label) || !window.url().is_ok_and(|url| trusted_page(&url)) {
        return Err(MENU_ERROR);
    }
    if rows.len() > ROW_LIMIT {
        rows.truncate(ROW_LIMIT);
    }
    let mut ids = std::collections::HashSet::new();
    let mut revisions = std::collections::HashSet::new();
    rows.retain(|row| {
        (1..=9_007_199_254_740_991).contains(&row.id)
            && !row.revision.is_nil()
            && ids.insert(row.id)
            && revisions.insert(row.revision)
    });
    for row in &mut rows {
        row.name = row
            .name
            .chars()
            .filter(|character| !character.is_control())
            .take(60)
            .collect();
    }
    let next = WindowAccounts {
        owner: label.to_owned(),
        rows,
        locked,
    };
    {
        let mut windows = state.0.lock().map_err(|_| MENU_ERROR)?;
        if windows.get(label) == Some(&next) {
            return Ok(());
        }
        windows.insert(label.to_owned(), next);
    }
    state.refresh(&app)
}

pub(crate) fn menu(app: &AppHandle, windows: &[WindowAccounts]) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let open = MenuItem::with_id(app, "open", "打开 Pulse IM", true, None::<&str>)?;
    menu.append(&open)?;
    let groups = app.state::<WorkspaceGroups>();
    for workspace in windows {
        let title = groups.window_name(&workspace.owner);
        let submenu = Submenu::new(app, title, true)?;
        let open_id = format!("window-open:{}", workspace.owner);
        submenu.append(&MenuItem::with_id(
            app,
            open_id,
            "打开窗口",
            true,
            None::<&str>,
        )?)?;
        for row in &workspace.rows {
            let name = if row.name.trim().is_empty() {
                format!("账号 {}", row.id)
            } else {
                row.name.replace('&', "&&")
            };
            let status = if workspace.locked {
                "（已锁定）"
            } else if !row.signed_in {
                "（需重新登录）"
            } else if row.active {
                "（当前账号）"
            } else {
                ""
            };
            let account = Submenu::new(app, format!("{name}{status}"), true)?;
            for (action, label) in [
                ("open", "切换到此账号"),
                ("logout", "退出登录"),
                ("remove", "删除本机账号"),
            ] {
                let id = format!("account:{action}:{}:{}", workspace.owner, row.revision);
                let enabled = match action {
                    "logout" => row.signed_in,
                    "remove" => !workspace.locked,
                    _ => true,
                };
                account.append(&MenuItem::with_id(app, id, label, enabled, None::<&str>)?)?;
            }
            submenu.append(&account)?;
        }
        let close_id = format!("window-close:{}", workspace.owner);
        submenu.append(&MenuItem::with_id(
            app,
            close_id,
            "退出窗口",
            true,
            None::<&str>,
        )?)?;
        menu.append(&submenu)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "new",
        "新开窗口",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "logs",
        "打开本地日志",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn new_workspace(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if open_group(&app, &app.state::<WorkspaceGroups>(), None)
            .await
            .is_err()
        {
            workspace::show_main(&app);
        }
    });
}

#[derive(Clone, Serialize)]
struct AccountAction<'a> {
    id: u64,
    revision: Uuid,
    action: &'a str,
}

pub fn activate(app: &AppHandle, id: &str) {
    match id {
        "open" => workspace::show_main(app),
        "new" => new_workspace(app),
        "logs" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::diagnostics::open_logs(&app).await;
            });
        }
        "quit" => app.exit(0),
        _ => {
            let parts: Vec<_> = id.split(':').collect();
            match parts.as_slice() {
                ["window-open", owner] if is_workspace(owner) => {
                    if let Some(view) = app.get_webview_window(owner) {
                        workspace::show(&view);
                    }
                }
                ["window-close", owner] if is_workspace(owner) => {
                    if let Some(view) = app.get_webview_window(owner) {
                        let _ = view.destroy();
                    }
                }
                ["account", action @ ("open" | "logout" | "remove"), owner, revision] => {
                    let Ok(revision) = Uuid::parse_str(revision) else {
                        return;
                    };
                    let state = app.state::<TrayAccounts>();
                    let row = state.0.lock().ok().and_then(|windows| {
                        let window = windows.get(*owner)?;
                        if *action == "remove" && window.locked {
                            return None;
                        }
                        window
                            .rows
                            .iter()
                            .find(|row| row.revision == revision)
                            .cloned()
                    });
                    if let (Some(row), Some(view)) = (row, app.get_webview_window(owner)) {
                        workspace::show(&view);
                        let _ = app.emit_to(
                            *owner,
                            EVENT,
                            AccountAction {
                                id: row.id,
                                revision,
                                action,
                            },
                        );
                    }
                }
                _ => {}
            }
        }
    }
}
