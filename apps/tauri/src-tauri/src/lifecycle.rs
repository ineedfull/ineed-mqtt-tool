use crate::boundary::{BeginClose, CloseLedger};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, CloseRequestApi, Emitter, Manager, Runtime, State, Window};
use uuid::Uuid;

const MAIN_WINDOW_LABEL: &str = "main";
const CLOSE_FALLBACK: Duration = Duration::from_secs(15);

#[derive(Clone, Default)]
pub struct CloseHandshake {
    ledger: Arc<Mutex<CloseLedger>>,
}

enum CloseStart {
    Started(String),
    AlreadyPending,
    ShuttingDown,
}

impl CloseHandshake {
    fn begin(&self, window_label: &str) -> CloseStart {
        loop {
            let request_id = Uuid::new_v4().to_string();
            let outcome = self
                .ledger
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .begin(window_label, &request_id);
            match outcome {
                BeginClose::Started => return CloseStart::Started(request_id),
                BeginClose::IdCollision => continue,
                BeginClose::AlreadyPending => return CloseStart::AlreadyPending,
                BeginClose::ShuttingDown => return CloseStart::ShuttingDown,
            }
        }
    }

    fn settle(&self, request_id: &str) -> Option<String> {
        self.ledger
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .settle(request_id)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BeforeCloseRequest {
    request_id: String,
}

fn shutdown_all_windows<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let mut windows: Vec<_> = app.webview_windows().into_iter().collect();
    windows.sort_by(|(left, _), (right, _)| left.cmp(right));

    let mut errors = Vec::new();
    for (label, window) in windows {
        if let Err(error) = window.destroy() {
            let detail = format!("failed to destroy window {label}: {error}");
            eprintln!("{detail}");
            errors.push(detail);
        }
    }
    app.exit(0);

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub fn request_main_close<R: Runtime>(window: &Window<R>, api: &CloseRequestApi) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    let handshake = window.state::<CloseHandshake>().inner().clone();
    let request_id = match handshake.begin(window.label()) {
        CloseStart::ShuttingDown => return,
        CloseStart::AlreadyPending => {
            api.prevent_close();
            return;
        }
        CloseStart::Started(request_id) => request_id,
    };
    api.prevent_close();
    let payload = BeforeCloseRequest {
        request_id: request_id.clone(),
    };

    if let Err(error) = window.emit("app:before-close", payload) {
        eprintln!("failed to emit app:before-close: {error}");
        if handshake.settle(&request_id).is_some() {
            if let Err(error) = shutdown_all_windows(window.app_handle()) {
                eprintln!("shutdown after close event failure: {error}");
            }
        }
        return;
    }

    let fallback_app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLOSE_FALLBACK).await;
        if handshake.settle(&request_id).is_some() {
            if let Err(error) = shutdown_all_windows(&fallback_app) {
                eprintln!("shutdown after close timeout: {error}");
            }
        }
    });
}

#[tauri::command]
pub async fn window_close_ready(
    app: AppHandle,
    state: State<'_, CloseHandshake>,
    request_id: String,
    ok: bool,
    error: Option<String>,
) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 128 || request_id.chars().any(char::is_control) {
        return Err("invalid close request id".to_owned());
    }
    if ok && error.is_some() {
        return Err("successful close acknowledgement cannot contain an error".to_owned());
    }

    state
        .settle(&request_id)
        .ok_or_else(|| "unknown or completed close request".to_owned())?;
    shutdown_all_windows(&app)
}
