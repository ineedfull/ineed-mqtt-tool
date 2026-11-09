use crate::{database::Database, update};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{oneshot, Notify};

const PUBLIC_KEY: &str = match option_env!("INEED_TAURI_UPDATE_PUBLIC_KEY") {
    Some(key) => key,
    None => "",
};
const MAX_DOWNLOAD_BYTES: u64 = 536_870_912;
type PreparationResult = Result<(), String>;
type PendingPreparation = Option<(String, oneshot::Sender<PreparationResult>)>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    phase: String,
    version: String,
    transferred: u64,
    total: u64,
    percent: f64,
    error: String,
    supported: bool,
    can_cancel: bool,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            version: String::new(),
            transferred: 0,
            total: 0,
            percent: 0.0,
            error: String::new(),
            supported: !PUBLIC_KEY.is_empty() && supported_platform(),
            can_cancel: true,
        }
    }
}

#[derive(Default)]
struct Payload {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct NativeUpdates {
    status: Mutex<UpdateState>,
    payload: tokio::sync::Mutex<Payload>,
    busy: AtomicBool,
    cancelled: AtomicBool,
    cancel: Notify,
    preparation: Mutex<PendingPreparation>,
}

struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl NativeUpdates {
    pub fn blocks_close(&self) -> bool {
        ["preparing", "installing"].contains(&self.snapshot().phase.as_str())
    }
    fn begin(&self) -> Result<Busy<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Update is busy".to_owned())?;
        Ok(Busy(&self.busy))
    }
    fn snapshot(&self) -> UpdateState {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    fn change<R: tauri::Runtime>(&self, app: &AppHandle<R>, change: impl FnOnce(&mut UpdateState)) {
        let snapshot = {
            let mut state = self.status.lock().unwrap_or_else(|e| e.into_inner());
            change(&mut state);
            state.clone()
        };
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit("update:changed", snapshot);
        }
    }
    fn phase<R: tauri::Runtime>(&self, app: &AppHandle<R>, phase: &str, error: String) {
        self.change(app, |state| {
            state.phase = phase.into();
            state.error = error;
        });
    }
    fn require_ready(&self) -> Result<(), String> {
        if self.snapshot().phase != "ready" {
            return Err("Update is not ready for installation".into());
        }
        Ok(())
    }
    fn acknowledge(
        &self,
        label: &str,
        id: &str,
        ok: bool,
        error: Option<String>,
    ) -> PreparationResult {
        if label != "main" {
            return Err("Update sender is not authorized".into());
        }
        let mut preparation = self.preparation.lock().unwrap_or_else(|e| e.into_inner());
        if preparation.as_ref().map(|(current, _)| current.as_str()) != Some(id) {
            return Err("Unknown update preparation".into());
        }
        let (_, sender) = preparation.take().unwrap();
        sender
            .send(if ok && error.is_none() {
                Ok(())
            } else {
                Err(error.unwrap_or_else(|| "更新前保存失败".into()))
            })
            .map_err(|_| "Update preparation expired".into())
    }
}

fn supported_platform() -> bool {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64" | "x86_64") | ("windows", "x86_64") => true,
        ("linux", "x86_64") => std::env::var_os("APPIMAGE").is_some(),
        _ => false,
    }
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Update sender is not authorized".into());
    }
    Ok(())
}

fn validate_artifact_url(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid update URL".to_owned())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str() != Some("downloads.ineedfull.com")
        || !url.path().starts_with("/ineed-mqtt-tool/")
    {
        return Err("Invalid HTTPS update artifact".into());
    }
    Ok(())
}

#[tauri::command]
pub fn update_state(
    window: WebviewWindow,
    state: State<'_, NativeUpdates>,
) -> Result<UpdateState, String> {
    authorize(&window)?;
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NativeUpdates>,
) -> Result<serde_json::Value, String> {
    authorize(&window)?;
    let _busy = state.begin()?;
    if !state.snapshot().supported {
        let legacy = update::update_check().await?;
        let mut result = serde_json::to_value(legacy).map_err(|e| e.to_string())?;
        result["automatic"] = serde_json::json!(false);
        return Ok(result);
    }
    let mut payload = state.payload.lock().await;
    payload.update = None;
    payload.bytes = None;
    state.phase(&app, "checking", String::new());
    let result: Result<serde_json::Value, String> = async {
        let channel = format!("tauri-{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        let endpoint = format!("https://mqtt.ineedfull.com/updates/tauri/{channel}.json");
        let updater = app.updater_builder().pubkey(PUBLIC_KEY).target(&channel)
            .endpoints(vec![endpoint.parse().map_err(|e: url::ParseError| e.to_string())?]).map_err(|e| e.to_string())?
            .timeout(Duration::from_secs(300))
            .configure_client(|client| client.redirect(updater_http::redirect::Policy::none()))
            .build().map_err(|e| e.to_string())?;
        let found = tokio::time::timeout(Duration::from_secs(10), updater.check()).await
            .map_err(|_| "Update check timed out".to_owned())?.map_err(|e| e.to_string())?;
        if let Some(update) = found {
            validate_artifact_url(update.download_url.as_str())?;
            state.change(&app, |s| { s.phase = "available".into(); s.version = update.version.clone(); s.percent = 0.0; s.transferred = 0; s.total = 0; });
            let info = serde_json::json!({ "available": true, "automatic": true, "version": update.version,
                "description": update.body.clone().unwrap_or_default(), "url": "", "force": false });
            payload.update = Some(update);
            Ok(info)
        } else {
            state.phase(&app, "idle", String::new());
            Ok(serde_json::json!({ "available": false, "automatic": true, "version": env!("CARGO_PKG_VERSION") }))
        }
    }.await;
    if let Err(ref error) = result {
        state.phase(&app, "error", error.clone());
    }
    result
}

#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NativeUpdates>,
) -> Result<UpdateState, String> {
    authorize(&window)?;
    download_native(&app, &state).await
}

async fn download_native<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &NativeUpdates,
) -> Result<UpdateState, String> {
    let _busy = state.begin()?;
    let mut payload = state.payload.lock().await;
    if !["available", "error"].contains(&state.snapshot().phase.as_str()) {
        return Err("No available update".into());
    }
    let update = payload.update.as_ref().ok_or("No available update")?;
    state.cancelled.store(false, Ordering::Release);
    // Consume any notification left by a completed download before starting another one.
    let _ = tokio::time::timeout(Duration::ZERO, state.cancel.notified()).await;
    state.phase(app, "downloading", String::new());
    let mut transferred = 0u64;
    let mut last_progress = Instant::now();
    let oversized = AtomicBool::new(false);
    let result = tokio::select! {
        result = update.download(|length, total| {
            transferred = transferred.saturating_add(length as u64);
            if transferred > MAX_DOWNLOAD_BYTES || total.is_some_and(|n| n > MAX_DOWNLOAD_BYTES) {
                oversized.store(true, Ordering::Release);
                state.cancel.notify_one();
            }
            if last_progress.elapsed() >= Duration::from_millis(150) {
                state.change(app, |s| { s.transferred = transferred; s.total = total.unwrap_or(0); s.percent = total.filter(|n| *n > 0).map_or(0.0, |n| (transferred as f64 * 100.0 / n as f64).min(100.0)); });
                last_progress = Instant::now();
            }
        }, || { state.phase(app, "verifying", String::new()); }) => result.map_err(|e| e.to_string()),
        _ = state.cancel.notified() => Err(if oversized.load(Ordering::Acquire) { "更新文件超过允许大小".into() } else { "下载已取消".into() }),
    };
    match result {
        Ok(bytes)
            if !state.cancelled.load(Ordering::Acquire) && !oversized.load(Ordering::Acquire) =>
        {
            let size = bytes.len() as u64;
            payload.bytes = Some(bytes);
            state.change(app, |s| {
                s.phase = "ready".into();
                s.transferred = size;
                s.total = size;
                s.percent = 100.0;
            });
            Ok(state.snapshot())
        }
        Ok(_) => {
            state.phase(app, "available", "下载已取消".into());
            Err("下载已取消".into())
        }
        Err(error) => {
            payload.bytes = None;
            state.phase(
                app,
                if state.cancelled.load(Ordering::Acquire) {
                    "available"
                } else {
                    "error"
                },
                error.clone(),
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub fn update_cancel(window: WebviewWindow, state: State<'_, NativeUpdates>) -> Result<(), String> {
    authorize(&window)?;
    if state.snapshot().phase != "downloading" {
        return Err("No download to cancel".into());
    }
    state.cancelled.store(true, Ordering::Release);
    state.cancel.notify_one();
    Ok(())
}

#[tauri::command]
pub fn update_prepare_ready(
    window: WebviewWindow,
    state: State<'_, NativeUpdates>,
    request_id: String,
    ok: bool,
    error: Option<String>,
) -> Result<(), String> {
    state.acknowledge(window.label(), &request_id, ok, error)
}

#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, NativeUpdates>,
    database: State<'_, Database>,
) -> Result<(), String> {
    authorize(&window)?;
    let _busy = state.begin()?;
    state.require_ready()?;
    let payload = state.payload.lock().await;
    let update = payload.update.as_ref().ok_or("No verified update")?;
    let bytes = payload.bytes.as_ref().ok_or("No verified update bytes")?;
    state.phase(&app, "preparing", String::new());
    let (sender, receiver) = oneshot::channel();
    let request_id = uuid::Uuid::new_v4().to_string();
    *state.preparation.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((request_id.clone(), sender));
    let result = async {
        crate::update_signature::verify(bytes, &update.signature, PUBLIC_KEY, &update.version)?;
        window
            .emit(
                "app:before-close",
                serde_json::json!({ "requestId": request_id, "purpose": "update" }),
            )
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(30), receiver)
            .await
            .map_err(|_| "更新前保存确认超时".to_owned())?
            .map_err(|_| "Update preparation unavailable".to_owned())??;
        database.checkpoint_for_update()?;
        Ok::<(), String>(())
    }
    .await;
    state
        .preparation
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Err(error) = result {
        state.phase(&app, "ready", error.clone());
        return Err(error);
    }
    state.phase(&app, "installing", String::new());
    if let Err(error) = update.install(bytes) {
        state.phase(&app, "ready", error.to_string());
        return Err(error.to_string());
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[tokio::test]
    async fn real_plugin_download_only_marks_valid_signed_bytes_ready() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        for corrupted in [false, true] {
            let bytes = b"isolated Tauri update bytes";
            let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
            let public = STANDARD.encode(pair.pk.to_box().unwrap().into_string());
            let signature = minisign::sign(
                Some(&pair.pk),
                &pair.sk,
                &bytes[..],
                Some("version:0.1.1"),
                None,
            )
            .unwrap();
            let signature = STANDARD.encode(signature.into_string());
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let manifest = serde_json::json!({ "version": "0.1.1", "platforms": { "test-target": {
                "url": format!("http://{address}/artifact"), "signature": signature
            } } })
            .to_string();
            let body = if corrupted {
                b"corrupted Tauri bytes".as_slice()
            } else {
                bytes.as_slice()
            }
            .to_vec();
            let server = std::thread::spawn(move || {
                for _ in 0..2 {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut input = [0; 4096];
                    let size = stream.read(&mut input).unwrap();
                    let response =
                        if String::from_utf8_lossy(&input[..size]).starts_with("GET /artifact ") {
                            &body[..]
                        } else {
                            manifest.as_bytes()
                        };
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        response.len()
                    )
                    .unwrap();
                    for chunk in response.chunks(3) {
                        stream.write_all(chunk).unwrap();
                    }
                }
            });
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            // HTTP is configured exclusively in the test MockRuntime; production rejects it.
            context.config_mut().version = Some("0.1.0".parse().unwrap());
            context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
                "pubkey": public, "dangerousInsecureTransportProtocol": true, "requireSignedVersion": true
            }));
            let app = tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .unwrap();
            let update = app
                .updater_builder()
                .target("test-target")
                .endpoints(vec![format!("http://{address}/latest.json")
                    .parse()
                    .unwrap()])
                .unwrap()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap()
                .check()
                .await
                .unwrap()
                .unwrap();
            let store = NativeUpdates::default();
            store.payload.lock().await.update = Some(update);
            store.status.lock().unwrap().phase = "available".into();
            let result = download_native(app.handle(), &store).await;
            if corrupted {
                assert!(result.is_err());
                assert_eq!(store.snapshot().phase, "error");
                assert!(store.payload.lock().await.bytes.is_none());
                assert!(store.require_ready().is_err());
            } else {
                assert_eq!(result.unwrap().phase, "ready");
                assert_eq!(
                    store.payload.lock().await.bytes.as_deref(),
                    Some(bytes.as_slice())
                );
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn native_update_rejects_foreign_runtime_and_insecure_artifacts() {
        assert!(validate_artifact_url(
            "https://downloads.ineedfull.com/ineed-mqtt-tool/0.1.1/build/mqtt.app.tar.gz"
        )
        .is_ok());
        for url in [
            "http://downloads.ineedfull.com/a",
            "https://other.example/a",
            "https://downloads.ineedfull.com/other-tool/a",
        ] {
            assert!(validate_artifact_url(url).is_err());
        }
    }

    #[test]
    fn install_requires_verified_state_and_exclusive_operation() {
        let store = NativeUpdates::default();
        assert!(store.require_ready().is_err());
        let guard = store.begin().unwrap();
        assert!(store.begin().is_err());
        drop(guard);
        assert!(store.begin().is_ok());
    }

    #[tokio::test]
    async fn only_current_primary_window_can_acknowledge_preparation() {
        let store = NativeUpdates::default();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        *store.preparation.lock().unwrap() = Some(("current".into(), sender));
        assert!(store.acknowledge("history", "current", true, None).is_err());
        assert!(store.acknowledge("main", "stale", true, None).is_err());
        store
            .acknowledge("main", "current", false, Some("disk full".into()))
            .unwrap();
        assert_eq!(receiver.await.unwrap(), Err("disk full".into()));
        assert!(store.acknowledge("main", "current", true, None).is_err());
    }
}
