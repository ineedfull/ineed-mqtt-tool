use ineed_mqtt_tool_lib::database::{Database, HistoryFilter, MessageInput};
use serde::Serialize;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{collections::HashMap, env, fs, io::ErrorKind, path::PathBuf, process};
use uuid::Uuid;

const LIVE_DATABASE_FILENAME: &str = "ineed-mqtt.db";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedStorage {
    message_count: i64,
    log_count: i64,
    publish_count: i64,
    total_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilteredMessagesCheck {
    topics: Vec<String>,
    total: i64,
    page: i64,
    page_size: i64,
}

#[derive(Serialize)]
struct FilteredLogsCheck {
    messages: Vec<String>,
    total: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CascadeCheck {
    connections: usize,
    subscriptions: usize,
    messages: i64,
    publish_history: usize,
    logs: i64,
    theme: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityChecks {
    filtered_messages: FilteredMessagesCheck,
    filtered_logs: FilteredLogsCheck,
    setting: String,
    cascade: CascadeCheck,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilitySnapshot {
    connections: Vec<ineed_mqtt_tool_lib::database::ConnectionRow>,
    subscriptions: Vec<ineed_mqtt_tool_lib::database::SubscriptionRow>,
    message_counts: Vec<ineed_mqtt_tool_lib::database::MessageCountsRow>,
    messages: Vec<ineed_mqtt_tool_lib::database::MessageHistoryRow>,
    logs: Vec<ineed_mqtt_tool_lib::database::LogHistoryRow>,
    publish_history: Vec<ineed_mqtt_tool_lib::database::PublishHistoryRow>,
    settings: HashMap<String, String>,
    storage: NormalizedStorage,
    compatibility_checks: CompatibilityChecks,
    user_version: i64,
}

struct BehaviorCopy {
    path: PathBuf,
}

impl BehaviorCopy {
    fn new(source: &PathBuf) -> Result<Self, String> {
        let path = source.with_file_name("behavior.db");
        fs::copy(source, &path).map_err(|error| error.to_string())?;
        set_private_file_permissions(&path)?;
        Ok(Self { path })
    }
}

impl Drop for BehaviorCopy {
    fn drop(&mut self) {
        for suffix in ["", "-shm", "-wal", "-journal"] {
            let _ = fs::remove_file(PathBuf::from(format!("{}{}", self.path.display(), suffix)));
        }
    }
}

struct PrivateWorkspace {
    directory: PathBuf,
    database_path: PathBuf,
}

impl PrivateWorkspace {
    fn new(source: &PathBuf) -> Result<Self, String> {
        let temporary_directory =
            fs::canonicalize(env::temp_dir()).map_err(|error| error.to_string())?;
        let directory = loop {
            let candidate = temporary_directory
                .join(format!("ineed-database-compat-harness-{}", Uuid::new_v4()));
            match fs::create_dir(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        };
        let database_path = directory.join("fixture.db");
        let workspace = Self {
            directory,
            database_path,
        };
        set_private_directory_permissions(&workspace.directory)?;
        fs::copy(source, &workspace.database_path).map_err(|error| error.to_string())?;
        set_private_file_permissions(&workspace.database_path)?;
        Ok(workspace)
    }

    fn database_path(&self) -> &PathBuf {
        &self.database_path
    }
}

impl Drop for PrivateWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &PathBuf) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &PathBuf) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &PathBuf) -> Result<(), String> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &PathBuf) -> Result<(), String> {
    Ok(())
}

fn fixture_path() -> Result<PathBuf, String> {
    let mut arguments = env::args_os().skip(1);
    let path = arguments
        .next()
        .ok_or_else(|| "expected exactly one absolute fixture path".to_string())?;
    if arguments.next().is_some() {
        return Err("expected exactly one absolute fixture path".into());
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("fixture path must be absolute".into());
    }
    if path
        .file_name()
        .is_some_and(|name| name == LIVE_DATABASE_FILENAME)
    {
        return Err("refusing live database filename".into());
    }
    if !fs::metadata(&path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        return Err("fixture path must name an existing regular file".into());
    }
    let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
    if canonical
        .file_name()
        .is_some_and(|name| name == LIVE_DATABASE_FILENAME)
    {
        return Err("refusing live database filename".into());
    }
    let temporary_directory =
        fs::canonicalize(env::temp_dir()).map_err(|error| error.to_string())?;
    if !canonical.starts_with(&temporary_directory) {
        return Err("fixture path must be inside the system temporary directory".into());
    }
    Ok(canonical)
}

fn compatibility_checks(source: &PathBuf) -> Result<CompatibilityChecks, String> {
    let behavior_copy = BehaviorCopy::new(source)?;
    let database = Database::open(&behavior_copy.path)?;
    let messages = (1..=21)
        .map(|index| MessageInput {
            connection_id: "compat-connection".into(),
            topic: format!("devices/compat/page-{index:02}"),
            payload: format!("compat needle {index}"),
            direction: "out".into(),
            qos: index % 3,
            retained: index % 2,
            format: "text".into(),
        })
        .collect::<Vec<_>>();
    database.save_messages(&messages)?;

    let message_page = database.query_history_messages(&HistoryFilter {
        conn_id: "compat-connection".into(),
        direction: "out".into(),
        keyword: "compat needle".into(),
        page: 2,
        page_size: 20,
        ..HistoryFilter::default()
    })?;
    let log_page = database.query_history_logs(&HistoryFilter {
        conn_id: "compat-connection".into(),
        level: "info".into(),
        keyword: "compat fixture".into(),
        page: 1,
        page_size: 20,
        ..HistoryFilter::default()
    })?;
    database.save_setting("theme", "light")?;
    let setting = database
        .get_all_settings()?
        .get("theme")
        .cloned()
        .unwrap_or_default();
    database.delete_connection("compat-connection")?;
    let cascade_message_page = database.query_history_messages(&HistoryFilter {
        conn_id: "compat-connection".into(),
        ..HistoryFilter::default()
    })?;
    let cascade_log_page = database.query_history_logs(&HistoryFilter {
        conn_id: "compat-connection".into(),
        ..HistoryFilter::default()
    })?;
    let cascade_theme = database
        .get_all_settings()?
        .get("theme")
        .cloned()
        .unwrap_or_default();

    Ok(CompatibilityChecks {
        filtered_messages: FilteredMessagesCheck {
            topics: message_page.rows.into_iter().map(|row| row.topic).collect(),
            total: message_page.total,
            page: message_page.page,
            page_size: message_page.page_size,
        },
        filtered_logs: FilteredLogsCheck {
            messages: log_page.rows.into_iter().map(|row| row.msg).collect(),
            total: log_page.total,
        },
        setting,
        cascade: CascadeCheck {
            connections: database.get_connections()?.len(),
            subscriptions: database.get_subscriptions("compat-connection")?.len(),
            messages: cascade_message_page.total,
            publish_history: database
                .get_publish_history("compat-connection", 100)?
                .len(),
            logs: cascade_log_page.total,
            theme: cascade_theme,
        },
    })
}

fn snapshot(path: PathBuf) -> Result<CompatibilitySnapshot, String> {
    let database = Database::open(&path)?;
    let filter = HistoryFilter {
        conn_id: "compat-connection".into(),
        page: 1,
        page_size: 100,
        ..HistoryFilter::default()
    };
    let storage = database.get_storage_stats()?;
    let connections = database.get_connections()?;
    let subscriptions = database.get_subscriptions("compat-connection")?;
    let message_counts = database.get_message_counts()?;
    let messages = database.query_history_messages(&filter)?.rows;
    let logs = database.query_history_logs(&filter)?.rows;
    let publish_history = database.get_publish_history("compat-connection", 100)?;
    let settings = database.get_all_settings()?;
    let user_version = database.get_schema_version()?;
    drop(database);
    Ok(CompatibilitySnapshot {
        connections,
        subscriptions,
        message_counts,
        messages,
        logs,
        publish_history,
        settings,
        storage: NormalizedStorage {
            message_count: storage.message_count,
            log_count: storage.log_count,
            publish_count: storage.publish_count,
            total_count: storage.total_count,
        },
        compatibility_checks: compatibility_checks(&path)?,
        user_version,
    })
}

fn run() -> Result<(), String> {
    let source = fixture_path()?;
    let workspace = PrivateWorkspace::new(&source)?;
    let first_open = Database::open(workspace.database_path())?;
    drop(first_open);
    let serialized = serde_json::to_string(&snapshot(workspace.database_path().clone())?)
        .map_err(|error| error.to_string())?;
    println!("{serialized}");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("database compatibility harness: {error}");
        process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    struct TestSource(PathBuf);

    impl Drop for TestSource {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn private_workspace_copies_permissions_inode_and_cleans_up() {
        let source = TestSource(
            env::temp_dir().join(format!("database-compat-harness-source-{}", Uuid::new_v4())),
        );
        fs::write(&source.0, b"fixture bytes").expect("write source");
        let workspace = PrivateWorkspace::new(&source.0).expect("private workspace");
        let directory = workspace.directory.clone();

        assert_eq!(
            fs::read(workspace.database_path()).expect("read private copy"),
            b"fixture bytes"
        );
        #[cfg(unix)]
        {
            let source_metadata = fs::metadata(&source.0).expect("source metadata");
            let directory_metadata =
                fs::metadata(&workspace.directory).expect("directory metadata");
            let database_metadata =
                fs::metadata(workspace.database_path()).expect("database metadata");
            assert_eq!(directory_metadata.mode() & 0o777, 0o700);
            assert_eq!(database_metadata.mode() & 0o777, 0o600);
            assert_ne!(database_metadata.ino(), source_metadata.ino());
        }

        drop(workspace);
        assert!(!directory.exists());
    }
}
