#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod archive_events;
mod archive_reader;
mod backend;
mod browser_cache;
mod chat_outbox;
mod chat_typography;
mod detached;
mod diagnostics;
mod downloads;
mod explorer_files;
mod http;
mod local_protection;
mod media_protocol;
mod network_settings;
mod notifications;
mod realtime;
mod routes;
mod screen_capture;
mod screen_pixels;
mod send_to_shortcut;
mod signins;
mod storage;
mod system_settings;
mod tray_accounts;
mod updates;
mod upload_stage;
mod windows_shell;
mod workspace;
mod workspace_groups;

use tauri::Manager;

fn main() {
    let storage = match storage::Storage::locate() {
        Ok(storage) => storage,
        Err(error) => {
            startup_error(&format!("无法写入便携版数据目录。请把程序移动到可写文件夹后重试。\n{error}"));
            return;
        }
    };
    let mut explorer_paths = explorer_files::paths(std::env::args_os());
    let result = tauri::Builder::default()
        .manage(storage)
        .register_asynchronous_uri_scheme_protocol(media_protocol::SCHEME, media_protocol::handle)
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            let startup = args.get(1).is_some_and(|arg| arg == "--startup");
            if let Some(paths) =
                explorer_files::paths(args.into_iter().map(std::ffi::OsString::from))
            {
                explorer_files::receive(app, paths);
            } else if startup {
                workspace::show_main(app);
            } else {
                tray_accounts::new_workspace(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(backend::Backend::new())
        .manage(notifications::Notifications::default())
        .manage(detached::DetachedWindows::default())
        .manage(explorer_files::ExplorerFiles::default())
        .manage(chat_outbox::ChatOutbox::default())
        .manage(realtime::Realtime::default())
        .manage(tray_accounts::TrayAccounts::default())
        .manage(updates::UpdateChecks::default())
        .manage(screen_capture::ScreenCapture::default())
        .invoke_handler(tauri::generate_handler![
            backend::desktop_info,
            browser_cache::clear_desktop_cache,
            diagnostics::report_desktop_diagnostic,
            diagnostics::open_desktop_logs,
            updates::check_desktop_update,
            updates::open_desktop_update,
            routes::desktop_routes,
            routes::select_desktop_route,
            routes::probe_desktop_route,
            routes::recover_desktop_route,
            network_settings::desktop_network_settings,
            network_settings::set_desktop_network_settings,
            network_settings::test_desktop_network_settings,
            network_settings::cancel_desktop_network_probe,
            network_settings::desktop_network_exit,
            chat_typography::chat_typography,
            chat_typography::set_chat_typography,
            chat_typography::import_chat_typography,
            screen_capture::begin_screen_capture,
            screen_capture::take_screen_capture,
            screen_capture::screen_capture_preview,
            screen_capture::complete_screen_capture,
            screen_capture::cancel_screen_capture,
            workspace_groups::list_workspace_groups,
            workspace_groups::import_legacy_workspace_groups,
            workspace_groups::open_workspace_group,
            workspace_groups::focus_primary_workspace,
            tray_accounts::sync_tray_accounts,
            detached::set_archive_session,
            detached::open_chat_window,
            detached::chat_window_context,
            detached::close_chat_windows,
            detached::relay_chat_window_packet,
            chat_outbox::chat_outbox_action,
            chat_outbox::reply_chat_outbox,
            chat_outbox::publish_chat_outbox,
            detached::open_archive_history,
            detached::archive_history_context,
            detached::archive_history_page,
            detached::archive_history_assets,
            detached::archive_copy_text,
            detached::archive_download_file,
            detached::open_archive_image,
            detached::archive_image,
            detached::archive_copy_image,
            detached::copy_conversation_image,
            detached::close_archive_window,
            detached::invalidate_archive,
            detached::observe_archive_event,
            downloads::download_preferences,
            downloads::choose_download_directory,
            downloads::set_download_prompt,
            downloads::start_download,
            downloads::list_downloads,
            downloads::cancel_download,
            downloads::cancel_account_downloads,
            http::api_start,
            http::api_execute,
            http::api_execute_upload,
            http::api_cancel,
            notifications::show_desktop_notice,
            notifications::desktop_notices_snapshot,
            notifications::desktop_notices_ready,
            notifications::desktop_notice_action,
            notifications::clear_desktop_notices,
            realtime::realtime_connect,
            realtime::realtime_send,
            realtime::realtime_disconnect,
            signins::remembered_signins,
            signins::read_remembered_signin,
            signins::remember_signin,
            signins::forget_remembered_signin,
            system_settings::open_system_sound_settings,
            system_settings::desktop_system_options,
            system_settings::set_desktop_system_option,
            explorer_files::pending_explorer_files,
            explorer_files::claim_explorer_files,
            explorer_files::unclaim_explorer_files,
            explorer_files::discard_explorer_files,
            explorer_files::prepare_explorer_file,
            upload_stage::create_upload_stage,
            upload_stage::push_upload_stage,
            upload_stage::seal_upload_stage,
            upload_stage::release_upload_stage
        ])
        .setup(move |app| {
            app.manage(http::ApiTransport::new(app.handle())?);
            if let Ok(logs) = diagnostics::Diagnostics::start(app.handle()) {
                app.manage(logs);
            }
            app.manage(downloads::Downloads::new(app.handle())?);
            app.manage(signins::SignIns::new(app.handle())?);
            app.manage(chat_typography::ChatTypography::load(app.handle())?);
            app.manage(upload_stage::UploadStages::new(app.handle())?);
            app.manage(system_settings::SystemSettings::load(app.handle())?);
            app.manage(workspace_groups::WorkspaceGroups::load(app.handle()));
            workspace::setup(app)?;
            app.state::<system_settings::SystemSettings>()
                .apply_initial(app.handle())?;
            notifications::supervise(app.handle().clone());
            explorer_files::supervise(app.handle().clone());
            if let Some(paths) = explorer_paths.take() {
                explorer_files::receive(app.handle(), paths);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => {
                window
                    .state::<workspace_groups::WorkspaceGroups>()
                    .mark_focused(window.label());
            }
            tauri::WindowEvent::Destroyed => {
                window
                    .state::<realtime::Realtime>()
                    .close_window(window.label());
                window
                    .state::<http::ApiTransport>()
                    .close_window(window.label());
                window
                    .state::<downloads::Downloads>()
                    .close_window(window.label());
                let app = window.app_handle().clone();
                app.state::<notifications::Notifications>()
                    .close_workspace(&app, window.label());
                app.state::<tray_accounts::TrayAccounts>()
                    .remove_window(&app, window.label());
                app.state::<backend::Backend>()
                    .routes
                    .remove(window.label());
                app.state::<http::ApiTransport>()
                    .network()
                    .close_window(window.label());
                app.state::<detached::DetachedWindows>()
                    .window_destroyed(&app, window.label());
                let label = window.label().to_owned();
                app.state::<explorer_files::ExplorerFiles>()
                    .close_window(&label);
                app.state::<screen_capture::ScreenCapture>()
                    .cancel_window(&label);
                tauri::async_runtime::spawn(async move {
                    app.state::<upload_stage::UploadStages>()
                        .close_window(&label)
                        .await;
                });
            }
            tauri::WindowEvent::CloseRequested { api, .. }
                if workspace::is_workspace(window.label()) =>
            {
                if window
                    .state::<system_settings::SystemSettings>()
                    .close_to_tray()
                {
                    if window.hide().is_ok() {
                        api.prevent_close();
                    }
                } else if window.label() == "main"
                    && !window
                        .app_handle()
                        .webview_windows()
                        .values()
                        .any(|view| workspace::group_id(view.label()).is_some())
                {
                    window.app_handle().exit(0);
                } else if window.label() == "main" && window.hide().is_ok() {
                    api.prevent_close();
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!());
    let app = match result {
        Ok(app) => app,
        Err(error) => {
            startup_error(&format!("Pulse IM 无法启动。请确认 Windows 已安装 Microsoft Edge WebView2 Runtime。\n{error}"));
            return;
        }
    };
    app.run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                if app
                    .state::<system_settings::SystemSettings>()
                    .close_to_tray()
                {
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(windows)]
fn startup_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let title: Vec<u16> = "Pulse IM".encode_utf16().chain([0]).collect();
    let message: Vec<u16> = message.encode_utf16().chain([0]).collect();
    unsafe { MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
}

#[cfg(not(windows))]
fn startup_error(message: &str) {
    eprintln!("{message}");
}
