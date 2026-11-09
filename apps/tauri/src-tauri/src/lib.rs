#![cfg_attr(test, allow(dead_code))]

mod boundary;
pub mod database;
mod lifecycle;
pub mod mqtt;
mod native_update;
mod update;
pub mod update_signature;
mod window;

use database::Database;
use lifecycle::CloseHandshake;
use mqtt::MqttService;
use serde::Deserialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, File},
    hash::Hasher,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, UNIX_EPOCH},
};
use tauri::{webview::PageLoadEvent, Listener, Manager, Runtime, WindowEvent};
use uuid::Uuid;

const MAIN_WINDOW_LABEL: &str = "main";
const SMOKE_PAGE_LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const DATABASE_FILENAME: &str = "ineed-mqtt.db";
const LEGACY_APP_DATA_DIR_NAMES: &[&str] = &["com.ineedfull.mqtt-desk"];

struct SmokeState {
    enabled: bool,
    page_load_started: AtomicBool,
    renderer_ready_disabled: bool,
    requested_exit_code: AtomicI32,
    lifecycle: Mutex<SmokeLifecycle>,
    profile_guard: Mutex<Option<ProfileGuard>>,
}

impl SmokeState {
    fn new(enabled: bool) -> Self {
        let challenge = if enabled {
            Uuid::new_v4().to_string()
        } else {
            String::new()
        };
        Self {
            enabled,
            page_load_started: AtomicBool::new(false),
            renderer_ready_disabled: enabled
                && std::env::var_os("INEED_SMOKE_DISABLE_RENDERER_READY")
                    .is_some_and(|value| value == "1"),
            requested_exit_code: AtomicI32::new(0),
            lifecycle: Mutex::new(SmokeLifecycle::new(challenge)),
            profile_guard: Mutex::new(None),
        }
    }
}

#[derive(Debug)]
struct SmokeLifecycle {
    challenge: String,
    page_finished: bool,
    renderer_ready: bool,
    shutdown_started: bool,
}

impl SmokeLifecycle {
    fn new(challenge: String) -> Self {
        Self {
            challenge,
            page_finished: false,
            renderer_ready: false,
            shutdown_started: false,
        }
    }

    fn challenge(&self) -> &str {
        &self.challenge
    }

    fn challenge_matches(&self, challenge: &str) -> bool {
        !self.challenge.is_empty() && challenge == self.challenge
    }

    fn record_page_finished(&mut self, challenge: &str) -> bool {
        if !self.challenge_matches(challenge) {
            return false;
        }
        self.page_finished = true;
        self.begin_shutdown_if_ready()
    }

    fn record_renderer_ready(&mut self, payload: RendererReadyPayload) -> bool {
        if !self.challenge_matches(&payload.challenge)
            || !payload.mounted
            || !payload.invoke_succeeded
        {
            return false;
        }
        self.renderer_ready = true;
        self.begin_shutdown_if_ready()
    }

    fn begin_shutdown_if_ready(&mut self) -> bool {
        if self.shutdown_started || !self.page_finished || !self.renderer_ready {
            return false;
        }
        self.shutdown_started = true;
        true
    }
}

fn page_challenge_matches(url: &tauri::Url, challenge: &str) -> bool {
    if challenge.is_empty() {
        return false;
    }
    let mut challenges = url
        .query_pairs()
        .filter(|(name, _)| name == "ineedSmokeChallenge")
        .map(|(_, value)| value);
    challenges.next().is_some_and(|value| value == challenge) && challenges.next().is_none()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RendererReadyPayload {
    challenge: String,
    mounted: bool,
    invoke_succeeded: bool,
}

#[derive(Deserialize)]
struct RendererErrorPayload {
    challenge: String,
    kind: String,
    reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    content_hash: u64,
    len: u64,
    modified_nanos: Option<u128>,
    readonly: bool,
}

impl FileFingerprint {
    fn capture(path: &Path) -> io::Result<Option<Self>> {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut file = File::open(path)?;
        let mut hasher = DefaultHasher::new();
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hasher.write(&buffer[..count]);
        }
        let modified_nanos = metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_nanos());
        Ok(Some(Self {
            content_hash: hasher.finish(),
            len: metadata.len(),
            modified_nanos,
            readonly: metadata.permissions().readonly(),
        }))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProfileFingerprint {
    database: Option<FileFingerprint>,
    shm: Option<FileFingerprint>,
    wal: Option<FileFingerprint>,
}

impl ProfileFingerprint {
    fn capture(directory: &Path) -> io::Result<Self> {
        Ok(Self {
            database: FileFingerprint::capture(&directory.join("ineed-mqtt.db"))?,
            shm: FileFingerprint::capture(&directory.join("ineed-mqtt.db-shm"))?,
            wal: FileFingerprint::capture(&directory.join("ineed-mqtt.db-wal"))?,
        })
    }
}

struct ProfileGuard {
    before: ProfileFingerprint,
    directory: PathBuf,
    smoke_canonical: PathBuf,
    smoke_directory: PathBuf,
}

impl ProfileGuard {
    fn verify_smoke_path(&self) -> io::Result<bool> {
        Ok(fs::canonicalize(&self.smoke_directory)? == self.smoke_canonical)
    }

    fn verify(&self) -> io::Result<bool> {
        Ok(self.verify_smoke_path()?
            && ProfileFingerprint::capture(&self.directory)? == self.before)
    }
}

fn canonicalize_allow_missing(path: &Path) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(io::Error::other("path must be absolute"));
    }
    let mut resolved = PathBuf::new();
    let mut missing_depth = 0_usize;
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                if !matches!(component, Component::Normal(_)) {
                    resolved.push(component.as_os_str());
                    continue;
                }
                let candidate = resolved.join(component.as_os_str());
                if missing_depth > 0 {
                    resolved = candidate;
                    missing_depth += 1;
                    continue;
                }
                match fs::canonicalize(&candidate) {
                    Ok(canonical) => resolved = canonical,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        resolved = candidate;
                        missing_depth = 1;
                    }
                    Err(error) => return Err(error),
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if resolved.file_name().is_some() {
                    resolved.pop();
                    missing_depth = missing_depth.saturating_sub(1);
                }
            }
        }
    }
    Ok(resolved)
}

fn validate_smoke_profile_isolation(
    smoke_directory: &Path,
    default_directory: &Path,
) -> io::Result<(PathBuf, PathBuf)> {
    let smoke_canonical = fs::canonicalize(smoke_directory)?;
    let default_canonical = canonicalize_allow_missing(default_directory)?;
    if smoke_canonical == default_canonical {
        return Err(io::Error::other(
            "INEED_SMOKE_APP_DATA resolves to the default app data directory",
        ));
    }
    Ok((smoke_canonical, default_canonical))
}

fn smoke_enabled() -> bool {
    std::env::var_os("INEED_SMOKE_TEST").is_some_and(|value| value == "1")
}

fn smoke_page_load_timeout() -> Duration {
    std::env::var("INEED_SMOKE_PAGE_LOAD_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|milliseconds| (100..=30_000).contains(milliseconds))
        .map(Duration::from_millis)
        .unwrap_or(SMOKE_PAGE_LOAD_TIMEOUT)
}

fn smoke_renderer_fault() -> Option<&'static str> {
    std::env::var_os("INEED_SMOKE_FAULT")
        .is_some_and(|value| value == "vue-lifecycle")
        .then_some("vue-lifecycle")
}

fn smoke_app_data_dir() -> io::Result<PathBuf> {
    let path = std::env::var_os("INEED_SMOKE_APP_DATA")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("INEED_SMOKE_APP_DATA must be nonblank"))?;
    validate_smoke_app_data_dir(path)
}

fn validate_smoke_app_data_dir(path: PathBuf) -> io::Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(io::Error::other("INEED_SMOKE_APP_DATA must be nonblank"));
    }
    if !path.is_absolute() {
        return Err(io::Error::other(
            "INEED_SMOKE_APP_DATA must be an absolute path",
        ));
    }
    Ok(path)
}

fn resolve_app_data_dir(default_directory: PathBuf) -> PathBuf {
    if default_directory.join(DATABASE_FILENAME).is_file() {
        return default_directory;
    }
    let Some(parent) = default_directory.parent() else {
        return default_directory;
    };
    for directory_name in LEGACY_APP_DATA_DIR_NAMES {
        let legacy_directory = parent.join(directory_name);
        if legacy_directory.join(DATABASE_FILENAME).is_file() {
            return legacy_directory;
        }
    }
    default_directory
}

fn smoke_marker(marker: &str) {
    let result = (|| -> io::Result<()> {
        let stdout = io::stdout();
        let mut output = stdout.lock();
        output.write_all(marker.as_bytes())?;
        output.write_all(b"\n")?;
        output.flush()
    })();
    if let Err(error) = result {
        eprintln!("failed to write Tauri smoke marker: {error}");
    }
}

fn smoke_error(marker: &str) {
    let result = (|| -> io::Result<()> {
        let stderr = io::stderr();
        let mut output = stderr.lock();
        output.write_all(marker.as_bytes())?;
        output.write_all(b"\n")?;
        output.flush()
    })();
    if let Err(error) = result {
        eprintln!("failed to write Tauri smoke error: {error}");
    }
}

fn request_smoke_exit<R: Runtime>(state: &SmokeState, app: &tauri::AppHandle<R>, mut code: i32) {
    let smoke_path_unchanged = state
        .profile_guard
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .map(ProfileGuard::verify_smoke_path)
        .transpose();
    match smoke_path_unchanged {
        Ok(Some(false)) => {
            smoke_error("mqtt-tool-smoke-profile-path-changed");
            code = 1;
        }
        Err(error) => {
            smoke_error(&format!(
                "mqtt-tool-smoke-profile-path-check-failed: {error}"
            ));
            code = 1;
        }
        Ok(Some(true) | None) => {}
    }
    state.requested_exit_code.fetch_max(code, Ordering::AcqRel);
    app.exit(code);
}

fn begin_smoke_shutdown<R: Runtime>(state: &SmokeState, app: &tauri::AppHandle<R>) {
    smoke_marker("mqtt-tool-ready");
    smoke_marker("mqtt-tool-shutdown");
    let mut windows: Vec<_> = app.webview_windows().into_iter().collect();
    windows.sort_by(|(left, _), (right, _)| left.cmp(right));
    for (label, window) in windows {
        if let Err(error) = window.destroy() {
            smoke_error(&format!(
                "mqtt-tool-page-load-failure: failed to destroy {label}: {error}"
            ));
            request_smoke_exit(state, app, 1);
            return;
        }
    }
}

pub fn run() {
    let smoke = Arc::new(SmokeState::new(smoke_enabled()));
    let setup_smoke = smoke.clone();
    let page_load_smoke = smoke.clone();
    let window_event_smoke = smoke.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(native_update::NativeUpdates::default())
        .manage(CloseHandshake::default())
        .setup(move |app| {
            let default_app_data_dir = app.path().app_data_dir()?;
            let app_data_dir = if setup_smoke.enabled {
                let path = smoke_app_data_dir()?;
                let (smoke_canonical, default_canonical) =
                    validate_smoke_profile_isolation(&path, &default_app_data_dir).inspect_err(
                        |_| {
                            smoke_error("mqtt-tool-profile-isolation-failure");
                        },
                    )?;
                let before = ProfileFingerprint::capture(&default_canonical)?;
                *setup_smoke
                    .profile_guard
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ProfileGuard {
                    before,
                    directory: default_canonical,
                    smoke_canonical: smoke_canonical.clone(),
                    smoke_directory: path,
                });
                smoke_marker("mqtt-tool-database-path:isolated-smoke-profile");
                smoke_canonical
            } else {
                resolve_app_data_dir(default_app_data_dir)
            };
            std::fs::create_dir_all(&app_data_dir)?;
            let database = Database::open(app_data_dir.join(DATABASE_FILENAME))
                .map_err(std::io::Error::other)?;
            let mqtt_service = MqttService::default();
            app.manage(database);
            app.manage(mqtt_service);
            if setup_smoke.enabled {
                smoke_marker("mqtt-tool-database-initialized");

                let ready_state = setup_smoke.clone();
                let ready_app = app.handle().clone();
                app.listen_any("app:renderer-ready", move |event| {
                    if ready_state.renderer_ready_disabled {
                        return;
                    }
                    let Ok(payload) = serde_json::from_str::<RendererReadyPayload>(event.payload())
                    else {
                        return;
                    };
                    let should_shutdown = ready_state
                        .lifecycle
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .record_renderer_ready(payload);
                    if should_shutdown {
                        begin_smoke_shutdown(&ready_state, &ready_app);
                    }
                });

                let error_state = setup_smoke.clone();
                let error_app = app.handle().clone();
                app.listen_any("app:renderer-error", move |event| {
                    let Ok(payload) = serde_json::from_str::<RendererErrorPayload>(event.payload())
                    else {
                        return;
                    };
                    let challenge_matches = error_state
                        .lifecycle
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .challenge_matches(&payload.challenge);
                    if !challenge_matches
                        || !matches!(
                            payload.kind.as_str(),
                            "bootstrap" | "error" | "unhandledrejection" | "vue"
                        )
                        || payload.reason.is_empty()
                        || payload.reason.len() > 32
                        || !payload.reason.chars().all(|character| character.is_ascii_alphabetic())
                    {
                        return;
                    }
                    smoke_error(&format!(
                        "mqtt-tool-renderer-error:{}:{}",
                        payload.kind, payload.reason
                    ));
                    request_smoke_exit(&error_state, &error_app, 1);
                });

                let challenge = setup_smoke
                    .lifecycle
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .challenge()
                    .to_owned();
                let main = app
                    .get_webview_window(MAIN_WINDOW_LABEL)
                    .ok_or_else(|| io::Error::other("main WebView is missing"))?;
                let mut smoke_url = main.url()?;
                {
                    let mut query = smoke_url.query_pairs_mut();
                    query
                        .clear()
                        .append_pair("ineedSmokeChallenge", &challenge);
                    if let Some(fault) = smoke_renderer_fault() {
                        query.append_pair("ineedSmokeFault", fault);
                    }
                }
                main.navigate(smoke_url)?;
            }
            Ok(())
        })
        .on_page_load(move |webview, payload| {
            if !page_load_smoke.enabled || webview.label() != MAIN_WINDOW_LABEL {
                return;
            }
            if payload.event() == PageLoadEvent::Started {
                if !page_load_smoke
                    .page_load_started
                    .swap(true, Ordering::AcqRel)
                {
                    let timeout_app = webview.app_handle().clone();
                    let timeout_smoke = page_load_smoke.clone();
                    let timeout = smoke_page_load_timeout();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(timeout).await;
                        let shutdown_started = timeout_smoke
                            .lifecycle
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .shutdown_started;
                        if !shutdown_started {
                            smoke_error(
                                "mqtt-tool-page-load-failure: main renderer did not finish handshake",
                            );
                            request_smoke_exit(&timeout_smoke, &timeout_app, 1);
                        }
                    });
                }
                return;
            }
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let challenge = page_load_smoke
                .lifecycle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .challenge()
                .to_owned();
            if !page_challenge_matches(payload.url(), &challenge) {
                return;
            }
            let should_shutdown = page_load_smoke
                .lifecycle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .record_page_finished(&challenge);
            if should_shutdown {
                begin_smoke_shutdown(&page_load_smoke, webview.app_handle());
            }
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && window.state::<native_update::NativeUpdates>().blocks_close() {
                    api.prevent_close();
                    return;
                }
                lifecycle::request_main_close(window, api);
            }
            if window_event_smoke.enabled
                && window.label() == MAIN_WINDOW_LABEL
                && matches!(event, WindowEvent::Destroyed)
                && window_event_smoke
                    .lifecycle
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .shutdown_started
            {
                smoke_marker("mqtt-tool-closed");
                let unchanged = window_event_smoke
                    .profile_guard
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_ref()
                    .ok_or_else(|| io::Error::other("default profile guard is missing"))
                    .and_then(ProfileGuard::verify);
                match unchanged {
                    Ok(true) => {
                        smoke_marker("mqtt-tool-default-profile-unchanged");
                        request_smoke_exit(&window_event_smoke, window.app_handle(), 0);
                    }
                    Ok(false) => {
                        smoke_error("mqtt-tool-default-profile-changed");
                        request_smoke_exit(&window_event_smoke, window.app_handle(), 1);
                    }
                    Err(error) => {
                        smoke_error(&format!(
                            "mqtt-tool-default-profile-check-failed: {error}"
                        ));
                        request_smoke_exit(&window_event_smoke, window.app_handle(), 1);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            database::db_get_connections,
            database::db_save_connection,
            database::db_delete_connection,
            database::db_get_message_counts,
            database::db_get_subscriptions,
            database::db_add_subscription,
            database::db_remove_subscription,
            database::db_save_messages,
            database::db_save_logs,
            database::db_query_history_messages,
            database::db_delete_history_message,
            database::db_clear_history_messages,
            database::db_query_history_logs,
            database::db_delete_history_log,
            database::db_clear_history_logs,
            database::db_get_publish_history,
            database::db_save_publish,
            database::db_get_all_settings,
            database::db_save_setting,
            database::db_get_storage_stats,
            database::db_clear_history_storage,
            mqtt::mqtt_connect,
            mqtt::mqtt_disconnect,
            mqtt::mqtt_subscribe,
            mqtt::mqtt_unsubscribe,
            mqtt::mqtt_publish,
            window::window_open_history,
            window::window_open_external,
            lifecycle::window_close_ready,
            native_update::update_check,
            native_update::update_state,
            native_update::update_download,
            native_update::update_cancel,
            native_update::update_install,
            native_update::update_prepare_ready,
        ])
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) if smoke.enabled => {
            smoke_error(&format!("mqtt-tool-smoke-startup-failure: {error}"));
            std::process::exit(1);
        }
        Err(error) => panic!("error while building Ineed MQTT Tool: {error}"),
    };
    let runtime_exit_code = app.run_return(|_, _| {});
    let exit_code = if smoke.enabled {
        smoke.requested_exit_code.load(Ordering::Acquire)
    } else {
        runtime_exit_code
    };
    std::process::exit(exit_code);
}

#[cfg(test)]
mod tests {
    use super::{
        canonicalize_allow_missing, page_challenge_matches, resolve_app_data_dir,
        validate_smoke_app_data_dir, validate_smoke_profile_isolation, FileFingerprint,
        ProfileFingerprint, ProfileGuard, RendererReadyPayload, SmokeLifecycle,
    };
    use std::{fs, path::PathBuf};
    use tauri::Url;

    #[test]
    fn smoke_app_data_rejects_blank_and_relative_paths() {
        assert!(validate_smoke_app_data_dir(PathBuf::new()).is_err());
        assert!(validate_smoke_app_data_dir(PathBuf::from("relative/profile")).is_err());
    }

    #[test]
    fn smoke_app_data_accepts_an_absolute_path_without_rewriting_it() {
        let path = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join("ineed-mqtt-tauri-smoke-validation");
        assert!(path.is_absolute());
        assert_eq!(validate_smoke_app_data_dir(path.clone()).unwrap(), path);
    }

    #[test]
    fn renamed_tauri_app_reuses_an_existing_mqtt_desk_database() {
        let directory = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join(format!("legacy-profile-{}", uuid::Uuid::new_v4()));
        let renamed_directory = directory.join("com.ineedfull.mqtt-tool");
        let legacy_directory = directory.join("com.ineedfull.mqtt-desk");
        fs::create_dir_all(&legacy_directory).unwrap();
        fs::write(legacy_directory.join("ineed-mqtt.db"), b"legacy database").unwrap();

        assert_eq!(resolve_app_data_dir(renamed_directory), legacy_directory);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn canonicalize_missing_path_resolves_existing_ancestor_and_normalizes_tail() {
        let directory = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join(format!("canonical-missing-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let expected = fs::canonicalize(&directory)
            .unwrap()
            .join("nested")
            .join("profile");
        let input = directory.join("unused").join("..").join("nested/profile");

        assert_eq!(canonicalize_allow_missing(&input).unwrap(), expected);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn smoke_symlink_alias_is_rejected_before_default_database_changes() {
        use std::os::unix::fs::symlink;

        let directory = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join(format!("profile-alias-{}", uuid::Uuid::new_v4()));
        let default_directory = directory.join("default");
        let smoke_alias = directory.join("smoke-alias");
        fs::create_dir_all(&default_directory).unwrap();
        let database = default_directory.join("ineed-mqtt.db");
        fs::write(&database, b"default-profile-sentinel").unwrap();
        symlink(&default_directory, &smoke_alias).unwrap();
        let before = FileFingerprint::capture(&database).unwrap();

        assert!(validate_smoke_profile_isolation(&smoke_alias, &default_directory).is_err());
        assert_eq!(FileFingerprint::capture(&database).unwrap(), before);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn profile_guard_detects_smoke_symlink_swap() {
        use std::os::unix::fs::symlink;

        let directory = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join(format!("profile-swap-{}", uuid::Uuid::new_v4()));
        let first = directory.join("first");
        let second = directory.join("second");
        let smoke_alias = directory.join("smoke-alias");
        let default_directory = directory.join("default");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::create_dir_all(&default_directory).unwrap();
        symlink(&first, &smoke_alias).unwrap();
        let guard = ProfileGuard {
            before: ProfileFingerprint::capture(&default_directory).unwrap(),
            directory: default_directory,
            smoke_canonical: fs::canonicalize(&first).unwrap(),
            smoke_directory: smoke_alias.clone(),
        };
        fs::remove_file(&smoke_alias).unwrap();
        symlink(&second, &smoke_alias).unwrap();

        assert!(!guard.verify().unwrap());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn renderer_lifecycle_requires_challenge_mount_invoke_and_page_finish() {
        let mut lifecycle = SmokeLifecycle::new("main-challenge".into());
        assert!(!lifecycle.record_renderer_ready(RendererReadyPayload {
            challenge: "main-challenge".into(),
            invoke_succeeded: true,
            mounted: false,
        }));
        assert!(!lifecycle.record_renderer_ready(RendererReadyPayload {
            challenge: "main-challenge".into(),
            invoke_succeeded: false,
            mounted: true,
        }));
        assert!(!lifecycle.record_renderer_ready(RendererReadyPayload {
            challenge: "history-spoof".into(),
            invoke_succeeded: true,
            mounted: true,
        }));
        assert!(!lifecycle.record_renderer_ready(RendererReadyPayload {
            challenge: "main-challenge".into(),
            invoke_succeeded: true,
            mounted: true,
        }));
        assert!(!lifecycle.record_page_finished("history-spoof"));
        assert!(lifecycle.record_page_finished("main-challenge"));
        assert!(!lifecycle.record_page_finished("main-challenge"));
        assert!(!lifecycle.record_renderer_ready(RendererReadyPayload {
            challenge: "main-challenge".into(),
            invoke_succeeded: true,
            mounted: true,
        }));
    }

    #[test]
    fn unchallenged_finish_then_ready_waits_for_challenged_finish() {
        let mut lifecycle = SmokeLifecycle::new("main-challenge".into());
        assert!(!lifecycle.record_page_finished(""));
        assert!(!lifecycle.record_renderer_ready(RendererReadyPayload {
            challenge: "main-challenge".into(),
            invoke_succeeded: true,
            mounted: true,
        }));
        assert!(lifecycle.record_page_finished("main-challenge"));
    }

    #[test]
    fn renderer_lifecycle_preserves_ready_first_race_until_page_finishes() {
        let mut lifecycle = SmokeLifecycle::new("main-challenge".into());
        assert!(!lifecycle.record_renderer_ready(RendererReadyPayload {
            challenge: "main-challenge".into(),
            invoke_succeeded: true,
            mounted: true,
        }));
        assert!(lifecycle.record_page_finished("main-challenge"));
    }

    #[test]
    fn page_challenge_requires_one_exact_current_value() {
        let challenge = "de305d54-75b4-431b-adb2-eb6b9e546014";
        let url = |query: &str| Url::parse(&format!("tauri://localhost/?{query}")).unwrap();

        assert!(!page_challenge_matches(&url("other=value"), challenge));
        assert!(!page_challenge_matches(
            &url("ineedSmokeChallenge=wrong"),
            challenge
        ));
        assert!(!page_challenge_matches(
            &url(&format!(
                "ineedSmokeChallenge={challenge}&ineedSmokeChallenge={challenge}"
            )),
            challenge
        ));
        assert!(page_challenge_matches(
            &url(&format!("other=value&ineedSmokeChallenge={challenge}")),
            challenge
        ));
    }

    #[test]
    fn profile_fingerprint_detects_create_modify_delete_and_sidecars() {
        let directory = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .join(format!("profile-fingerprint-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let database = directory.join("ineed-mqtt.db");
        let shm = directory.join("ineed-mqtt.db-shm");
        let wal = directory.join("ineed-mqtt.db-wal");

        let absent = ProfileFingerprint::capture(&directory).unwrap();
        fs::write(&database, vec![b'a'; 20_000]).unwrap();
        let created = ProfileFingerprint::capture(&directory).unwrap();
        assert_ne!(created, absent);

        fs::write(&database, vec![b'b'; 20_000]).unwrap();
        let modified = ProfileFingerprint::capture(&directory).unwrap();
        assert_ne!(
            modified, created,
            "streaming content hash must detect same-size writes"
        );

        fs::write(&wal, b"sidecar").unwrap();
        let sidecar = ProfileFingerprint::capture(&directory).unwrap();
        assert_ne!(sidecar, modified);

        fs::write(&shm, b"shared-memory sidecar").unwrap();
        let both_sidecars = ProfileFingerprint::capture(&directory).unwrap();
        assert_ne!(both_sidecars, sidecar);

        fs::remove_file(&database).unwrap();
        let deleted = ProfileFingerprint::capture(&directory).unwrap();
        assert_ne!(deleted, both_sidecars);
        fs::remove_dir_all(directory).unwrap();
    }
}
