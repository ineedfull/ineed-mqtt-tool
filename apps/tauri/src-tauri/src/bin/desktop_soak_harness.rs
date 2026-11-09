//! Test-only native WebView host. Uses production commands, services and renderer.
use ineed_mqtt_tool_lib::{
    database::{self, ConnectionInput, Database},
    mqtt::{self, MqttService},
};
use std::io::{BufRead, Write};
use tauri::Manager;

// Optional local diagnostics, confined to this explicitly enabled test binary.
// The bridge runs on the UI thread and never ships in the production app.
#[cfg(target_os = "macos")]
fn run_native_probe(request: String) {
    use std::ffi::{c_char, c_void, CString};
    use std::sync::OnceLock;
    extern "C" {
        fn dlopen(path: *const c_char, mode: i32) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }
    static PROBE: OnceLock<usize> = OnceLock::new();
    let function = *PROBE.get_or_init(|| {
        let path = CString::new(
            std::env::var("INEED_DESKTOP_SOAK_NATIVE_PROBE").expect("diagnostic bridge path"),
        )
        .unwrap();
        unsafe {
            let library = dlopen(path.as_ptr(), 2);
            assert!(!library.is_null(), "failed to load diagnostic bridge");
            let symbol = CString::new("mqtt_heap_probe").unwrap();
            let function = dlsym(library, symbol.as_ptr());
            assert!(!function.is_null(), "missing diagnostic bridge entrypoint");
            function as usize
        }
    });
    let request = CString::new(request).unwrap();
    unsafe {
        let invoke: unsafe extern "C" fn(*const c_char) = std::mem::transmute(function);
        invoke(request.as_ptr());
    }
}

#[tauri::command]
fn desktop_soak_report(id: String, mut result: serde_json::Value, app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        result["nativeWindow"] = serde_json::json!({
            "title": window.title().ok(),
            "visible": window.is_visible().ok(),
            "minimized": window.is_minimized().ok(),
            "focused": window.is_focused().ok(),
            "position": window.outer_position().ok(),
            "size": window.inner_size().ok(),
            "scaleFactor": window.scale_factor().ok(),
        });
    }
    println!("SOAK {}", serde_json::json!({"id": id, "result": result}));
    std::io::stdout().flush().unwrap();
}

fn main() {
    let profile = std::path::PathBuf::from(
        std::env::var("INEED_DESKTOP_SOAK_PROFILE").expect("isolated profile"),
    );
    assert!(
        profile.starts_with(std::env::temp_dir())
            || profile.starts_with("/private/tmp")
            || profile.starts_with("/tmp")
    );
    std::fs::create_dir_all(&profile).unwrap();
    let db = Database::open(profile.join("ineed-mqtt.db")).unwrap();
    db.save_connection(ConnectionInput {
        id: "desktop-soak".into(),
        name: "Desktop Soak".into(),
        host: "127.0.0.1".into(),
        port: Some(
            std::env::var("INEED_DESKTOP_SOAK_PORT")
                .unwrap()
                .parse()
                .unwrap(),
        ),
        protocol: "mqtt".into(),
        client_id: "desktop-soak-tauri".into(),
        username: "compat-user".into(),
        password: "compat-pass".into(),
        clean_session: Some(1),
        keepalive: Some(30),
        ..Default::default()
    })
    .unwrap();
    db.save_setting("persistReceiveLogs", "false").unwrap();
    let script =
        std::fs::read_to_string(std::env::var("INEED_DESKTOP_SOAK_DRIVER").unwrap()).unwrap();
    let visible = std::env::var("INEED_DESKTOP_SOAK_HIDDEN").as_deref() != Ok("1");
    let placement: serde_json::Value = serde_json::from_str(
        &std::env::var("INEED_DESKTOP_SOAK_WINDOW").unwrap_or_else(|_| "{}".into()),
    )
    .unwrap();
    // Keep the production window policy while isolating the application ID.
    let mut context = tauri::generate_context!();
    let main_window_config = context
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .expect("production main window configuration");
    context.config_mut().identifier = "com.ineedfull.mqtt-desktop-soak".into();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(db).manage(MqttService::default())
        .invoke_handler(tauri::generate_handler![desktop_soak_report,
            database::db_get_connections, database::db_save_connection, database::db_delete_connection,
            database::db_get_message_counts, database::db_get_subscriptions, database::db_add_subscription, database::db_remove_subscription,
            database::db_save_messages, database::db_save_logs, database::db_query_history_messages, database::db_delete_history_message,
            database::db_clear_history_messages, database::db_query_history_logs, database::db_delete_history_log, database::db_clear_history_logs,
            database::db_get_publish_history, database::db_save_publish, database::db_get_all_settings, database::db_save_setting,
            database::db_get_storage_stats, database::db_clear_history_storage,
            mqtt::mqtt_connect, mqtt::mqtt_disconnect, mqtt::mqtt_subscribe, mqtt::mqtt_unsubscribe, mqtt::mqtt_publish])
        .setup(move |app| {
            let window = tauri::WebviewWindowBuilder::from_config(app, &main_window_config)?
                .visible(visible)
                .always_on_top(std::env::var("INEED_DESKTOP_SOAK_KEEP_VISIBLE").as_deref() == Ok("1"))
                .position(placement["x"].as_f64().unwrap_or(40.0), placement["y"].as_f64().unwrap_or(40.0))
                .inner_size(placement["width"].as_f64().unwrap_or(1360.0), placement["height"].as_f64().unwrap_or(860.0))
                .initialization_script(format!("{script}\nwindow.addEventListener('DOMContentLoaded', () => setTimeout(() => installDesktopSoak({{runtime:'tauri'}}).catch(e => window.__TAURI_INTERNALS__.invoke('desktop_soak_report', {{id:'ready',result:{{failed:String(e.stack)}}}})), 500));"))
                .build()?;
            if visible {
                window.show()?;
                window.unminimize()?;
                window.set_focus()?;
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                    if line == "EXIT" { handle.exit(0); break; }
                    #[cfg(target_os = "macos")]
                    if let Some(request) = line.strip_prefix("PROBE ") {
                        let request = request.to_owned();
                        handle.run_on_main_thread(move || run_native_probe(request)).unwrap();
                        continue;
                    }
                    if let Some(window) = handle.get_webview_window("main") {
                        if line == "SHOW" {
                            window.show().unwrap();
                            window.unminimize().unwrap();
                            window.set_focus().unwrap();
                            continue;
                        }
                        window.eval(format!("window.desktopSoakCommand({line})")).unwrap();
                    }
                }
            });
            Ok(())
        })
        .run(context).expect("native soak host");
}
