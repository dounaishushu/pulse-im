use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Url, WebviewWindowBuilder,
};

pub(crate) fn group_id(label: &str) -> Option<uuid::Uuid> {
    uuid::Uuid::parse_str(label.strip_prefix("workspace-")?).ok()
}

pub(crate) fn conversation_window(label: &str) -> bool {
    label
        .strip_prefix("conversation-")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

pub(crate) fn is_workspace(label: &str) -> bool {
    label == "main" || group_id(label).is_some()
}

pub(crate) fn show(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn show_main(app: &AppHandle) {
    if let Some(groups) = app.try_state::<crate::workspace_groups::WorkspaceGroups>() {
        groups.focus_recent(app);
    } else if let Some(window) = app.get_webview_window("main") {
        show(&window);
    }
}

pub(crate) fn trusted_page(url: &Url) -> bool {
    #[cfg(not(feature = "custom-protocol"))]
    if url.origin().ascii_serialization() == "http://127.0.0.1:18085" {
        return true;
    }
    url.origin().ascii_serialization() == "https://tauri.localhost"
}

pub(crate) fn clear_reloaded_workspace(
    window: tauri::WebviewWindow,
    page: tauri::webview::PageLoadPayload<'_>,
) {
    if page.event() != tauri::webview::PageLoadEvent::Started {
        return;
    }
    let label = window.label();
    let app = window.app_handle();
    app.state::<crate::detached::DetachedWindows>()
        .window_destroyed(app, label);
    app.state::<crate::realtime::Realtime>().close_window(label);
    app.state::<crate::notifications::Notifications>()
        .close_workspace(app, label);
    app.state::<crate::tray_accounts::TrayAccounts>()
        .remove_window(app, label);
}

pub(crate) fn ensure_primary(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window("main") {
        return Ok(window);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or(tauri::Error::WindowNotFound)?;
    let mut builder = WebviewWindowBuilder::from_config(app, config)?;
    if let Some(directory) = crate::storage::webview(app) {
        builder = builder.data_directory(directory);
    }
    builder.on_navigation(trusted_page)
        .on_page_load(crate::workspace::clear_reloaded_workspace)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    ensure_primary(app.handle())?;
    let menu = crate::tray_accounts::menu(app.handle(), &[])?;
    let mut tray = TrayIconBuilder::with_id("workspace")
        .tooltip(&app.config().product_name.clone().unwrap_or_else(|| "Pulse IM".into()))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| crate::tray_accounts::activate(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
