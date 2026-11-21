#[cfg(windows)]
use std::time::Duration;

use tauri::{State, WebviewWindow};
use uuid::Uuid;

use crate::detached::DetachedWindows;
use crate::workspace::is_workspace;

const FAILED: &str = "无法清理本窗口的资源缓存，请稍后重试。";

#[tauri::command]
pub async fn clear_desktop_cache(
    window: WebviewWindow,
    windows: State<'_, DetachedWindows>,
    lease: Uuid,
) -> Result<(), &'static str> {
    if !is_workspace(window.label()) {
        return Err(FAILED);
    }
    let scope = windows.download_scope(&window, lease)?;
    #[cfg(windows)]
    {
        use std::sync::{Arc, Mutex};
        use tokio::sync::oneshot;
        use webview2_com::{
            ClearBrowsingDataCompletedHandler,
            Microsoft::Web::WebView2::Win32::{
                ICoreWebView2Profile2, ICoreWebView2_13,
                COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
            },
        };
        use windows::core::Interface;

        let (send, done) = oneshot::channel();
        let cancel = scope.cancel;
        let requested = cancel.clone();
        window
            .with_webview(move |view| {
                if requested.is_cancelled() {
                    let _ = send.send(Err(FAILED));
                    return;
                }
                let reply = Arc::new(Mutex::new(Some(send)));
                let completed = reply.clone();
                // Clear only HTTP cache in this workspace profile. Storage, cookies,
                // account tokens, download history and permissions have separate flags.
                let result = unsafe {
                    view.controller()
                        .CoreWebView2()
                        .and_then(|webview| webview.cast::<ICoreWebView2_13>())
                        .and_then(|webview| webview.Profile())
                        .and_then(|profile| profile.cast::<ICoreWebView2Profile2>())
                        .and_then(|profile| {
                            profile.ClearBrowsingData(
                                COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
                                &ClearBrowsingDataCompletedHandler::create(Box::new(
                                    move |result| {
                                        if let Ok(mut reply) = completed.lock() {
                                            if let Some(send) = reply.take() {
                                                let _ = send.send(result.map_err(|_| FAILED));
                                            }
                                        }
                                        Ok(())
                                    },
                                )),
                            )
                        })
                };
                if result.is_err() {
                    if let Ok(mut reply) = reply.lock() {
                        if let Some(send) = reply.take() {
                            let _ = send.send(Err(FAILED));
                        }
                    }
                }
            })
            .map_err(|_| FAILED)?;
        tokio::select! {
            _ = cancel.cancelled() => Err(FAILED),
            result = tokio::time::timeout(Duration::from_secs(15), done) => {
                result.map_err(|_| FAILED)?.map_err(|_| FAILED)?
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = scope;
        Err(FAILED)
    }
}
