mod schema;
use schema::validate_required_schema;

use chrono::Local;
use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use tauri::State;
use uuid::Uuid;

#[rustfmt::skip]
const BASELINE_SCHEMA: &str = include_str!("../../../../packages/persistence-contract/migrations/001-current-schema.sql");
const CONNECTION_PRAGMAS: &str =
    include_str!("../../../../packages/persistence-contract/migrations/connection-pragmas.sql");
const SCHEMA_VERSION: i64 = 1;
const REQUIRED_TABLES: &[&str] = &[
    "connections",
    "subscriptions",
    "message_history",
    "publish_history",
    "settings",
    "logs",
];
const REQUIRED_INDEXES: &[&str] = &["idx_message_history_conn_time_id", "idx_logs_conn_time_id"];

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
    path: PathBuf,
    received_history_error: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionRow {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub protocol: String,
    pub path: String,
    pub client_id: String,
    pub username: String,
    pub password: String,
    pub ssl: i64,
    pub keepalive: i64,
    pub clean_session: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConnectionInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<i64>,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub ssl: i64,
    #[serde(default)]
    pub keepalive: Option<i64>,
    #[serde(default)]
    pub clean_session: Option<i64>,
    #[serde(default)]
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SubscriptionRow {
    pub id: String,
    pub connection_id: String,
    pub topic: String,
    pub qos: i64,
    pub status: String,
    pub color: String,
    pub format: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SubscriptionInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub qos: i64,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub format: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageCountsRow {
    pub connection_id: String,
    pub messages_in: i64,
    pub messages_out: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct MessageInput {
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub payload: String,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub qos: i64,
    #[serde(default)]
    pub retained: i64,
    #[serde(default)]
    pub format: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PublishInput {
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub payload: String,
    #[serde(default)]
    pub qos: i64,
    #[serde(default)]
    pub retained: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishHistoryRow {
    pub id: i64,
    pub connection_id: String,
    pub topic: String,
    pub payload: String,
    pub qos: i64,
    pub retained: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LogInput {
    #[serde(default, rename = "connId", alias = "connection_id")]
    pub connection_id: String,
    #[serde(default)]
    pub time: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub msg: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilter {
    #[serde(default, alias = "connection_id")]
    pub conn_id: String,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub keyword: String,
    #[serde(default)]
    pub page: i64,
    #[serde(default, alias = "page_size")]
    pub page_size: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageHistoryRow {
    pub id: i64,
    pub connection_id: String,
    pub topic: String,
    pub payload: String,
    pub direction: String,
    pub qos: i64,
    pub retained: i64,
    pub format: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogHistoryRow {
    pub id: i64,
    pub connection_id: String,
    pub time: String,
    pub level: String,
    pub msg: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage<T> {
    pub rows: Vec<T>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub message_count: i64,
    pub log_count: i64,
    pub publish_count: i64,
    pub total_count: i64,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub shm_bytes: u64,
    pub total_bytes: u64,
}

fn database_error(error: rusqlite::Error) -> String {
    error.to_string()
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_xinfo({table})"))
        .map_err(database_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(database_error)?;
    for name in rows {
        if name.map_err(database_error)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn history_timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

fn received_topic_specificity(topic: &str) -> i64 {
    (topic.split('/').filter(|level| !level.is_empty()).count() * 100) as i64
        + topic
            .chars()
            .filter(|c| *c != '+' && *c != '#')
            .map(|c| c.len_utf16() as i64)
            .sum::<i64>()
        - (topic.chars().filter(|c| *c == '+' || *c == '#').count() * 20) as i64
}

fn received_topic_matches(topic: &str, filter: &str) -> bool {
    let topics: Vec<_> = topic.split('/').collect();
    let filters: Vec<_> = filter.split('/').collect();
    for (index, level) in filters.iter().enumerate() {
        if *level == "#" {
            return index == filters.len() - 1;
        }
        if index >= topics.len() || (*level != "+" && *level != topics[index]) {
            return false;
        }
    }
    topics.len() == filters.len()
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        let connection = Connection::open(&path).map_err(database_error)?;
        let database = Self {
            connection: Arc::new(Mutex::new(connection)),
            path,
            received_history_error: Arc::new(Mutex::new(None)),
        };
        database.initialize()?;
        Ok(database)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "database lock poisoned".to_string())
    }

    fn initialize(&self) -> Result<(), String> {
        let mut connection = self.lock()?;
        connection
            .execute_batch(CONNECTION_PRAGMAS)
            .map_err(database_error)?;
        let current_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(database_error)?;
        if current_version > SCHEMA_VERSION {
            return Err(format!(
                "database schema version {current_version} is newer than supported version {SCHEMA_VERSION}"
            ));
        }

        let transaction = connection.transaction().map_err(database_error)?;
        transaction
            .execute_batch(BASELINE_SCHEMA)
            .map_err(database_error)?;
        Self::apply_additive_migrations(&transaction)?;
        validate_required_schema(&transaction)?;
        transaction
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)
    }

    fn apply_additive_migrations(connection: &Connection) -> Result<(), String> {
        const COLUMNS: &[(&str, &str, &str)] = &[
            ("subscriptions", "color", "TEXT DEFAULT ''"),
            ("subscriptions", "format", "TEXT DEFAULT 'json'"),
            ("message_history", "format", "TEXT DEFAULT ''"),
        ];
        for (table, column, definition) in COLUMNS {
            if !has_column(connection, table, column)? {
                connection
                    .execute_batch(&format!(
                        "ALTER TABLE {table} ADD COLUMN {column} {definition};"
                    ))
                    .map_err(database_error)?;
            }
        }
        connection
            .execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_message_history_conn_time_id
                   ON message_history (connection_id, created_at, id);
                 CREATE INDEX IF NOT EXISTS idx_logs_conn_time_id
                   ON logs (connection_id, created_at, id);",
            )
            .map_err(database_error)
    }

    pub fn checkpoint_for_update(&self) -> Result<(), String> {
        if self
            .received_history_error
            .lock()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err(
                "Received history write failed; restart before installing an update".into(),
            );
        }
        let conn = self.lock()?;
        let (busy, _, _): (i64, i64, i64) = conn
            .query_row("PRAGMA wal_checkpoint(FULL)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| e.to_string())?;
        if busy != 0 {
            return Err("SQLite checkpoint is busy".into());
        }
        Ok(())
    }

    pub fn get_connections(&self) -> Result<Vec<ConnectionRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id,name,host,COALESCE(port,1883),COALESCE(protocol,'mqtt'),COALESCE(path,''),
                    COALESCE(client_id,''),COALESCE(username,''),COALESCE(password,''),COALESCE(ssl,0),
                    COALESCE(keepalive,60),COALESCE(clean_session,1),COALESCE(sort_order,0),
                    COALESCE(created_at,''),COALESCE(updated_at,'')
             FROM connections ORDER BY sort_order,id",
        ).map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(ConnectionRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get(3)?,
                    protocol: row.get(4)?,
                    path: row.get(5)?,
                    client_id: row.get(6)?,
                    username: row.get(7)?,
                    password: row.get(8)?,
                    ssl: row.get(9)?,
                    keepalive: row.get(10)?,
                    clean_session: row.get(11)?,
                    sort_order: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(rows)
    }

    pub fn save_connection(&self, mut input: ConnectionInput) -> Result<String, String> {
        if input.id.trim().is_empty() {
            input.id = format!("conn-{}", Uuid::new_v4());
        }
        let protocol = if input.protocol.is_empty() {
            "mqtt"
        } else {
            &input.protocol
        };
        let now = history_timestamp();
        self.lock()?.execute(
            "INSERT INTO connections (id,name,host,port,protocol,path,client_id,username,password,ssl,keepalive,clean_session,sort_order,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,host=excluded.host,port=excluded.port,
               protocol=excluded.protocol,path=excluded.path,client_id=excluded.client_id,username=excluded.username,
               password=excluded.password,ssl=excluded.ssl,keepalive=excluded.keepalive,
               clean_session=excluded.clean_session,sort_order=excluded.sort_order,updated_at=excluded.updated_at",
            params![input.id, input.name, input.host, input.port.unwrap_or(1883),
                protocol, input.path, input.client_id, input.username, input.password, input.ssl,
                input.keepalive.unwrap_or(60), input.clean_session.unwrap_or(1), input.sort_order, now],
        ).map_err(database_error)?;
        Ok(input.id)
    }

    pub fn delete_connection(&self, id: &str) -> Result<(), String> {
        self.lock()?
            .execute("DELETE FROM connections WHERE id=?", [id])
            .map_err(database_error)?;
        Ok(())
    }

    pub fn get_subscriptions(&self, connection_id: &str) -> Result<Vec<SubscriptionRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id,connection_id,topic,COALESCE(qos,0),COALESCE(status,'active'),COALESCE(color,''),COALESCE(format,'json'),COALESCE(created_at,'')
             FROM subscriptions WHERE connection_id=? ORDER BY created_at,id",
        ).map_err(database_error)?;
        let rows = statement
            .query_map([connection_id], |row| {
                Ok(SubscriptionRow {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    topic: row.get(2)?,
                    qos: row.get(3)?,
                    status: row.get(4)?,
                    color: row.get(5)?,
                    format: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(rows)
    }

    pub fn get_message_counts(&self) -> Result<Vec<MessageCountsRow>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT connection_id,
               SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END),
               SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END)
             FROM message_history GROUP BY connection_id ORDER BY connection_id",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(MessageCountsRow {
                    connection_id: row.get(0)?,
                    messages_in: row.get(1)?,
                    messages_out: row.get(2)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(rows)
    }

    pub fn add_subscription(&self, mut input: SubscriptionInput) -> Result<String, String> {
        if input.id.trim().is_empty() {
            input.id = format!("sub-{}", Uuid::new_v4());
        }
        let status = if input.status.is_empty() {
            "active"
        } else {
            &input.status
        };
        let format = if input.format.is_empty() {
            "json"
        } else {
            &input.format
        };
        self.lock()?.execute(
            "INSERT INTO subscriptions (id,connection_id,topic,qos,status,color,format) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET connection_id=excluded.connection_id,topic=excluded.topic,
               qos=excluded.qos,status=excluded.status,color=excluded.color,format=excluded.format",
            params![input.id, input.connection_id, input.topic, input.qos, status, input.color, format],
        ).map_err(database_error)?;
        Ok(input.id)
    }

    pub fn remove_subscription(&self, id: &str) -> Result<(), String> {
        self.lock()?
            .execute("DELETE FROM subscriptions WHERE id=?", [id])
            .map_err(database_error)?;
        Ok(())
    }

    // A busy WebView cannot evict reception history. This bounded MQTT batch
    // is committed on the native side before the display event is emitted.
    pub fn save_received_messages(
        &self,
        messages: &[crate::mqtt::MqttMessageEvent],
    ) -> Result<(), String> {
        let result = (|| {
            let settings = self.get_all_settings()?;
            let fallback = settings
                .get("payloadFormat")
                .map(String::as_str)
                .unwrap_or("text");
            let mut subscriptions = HashMap::new();
            let mut rows = Vec::with_capacity(messages.len());
            for message in messages {
                if !subscriptions.contains_key(&message.conn_id) {
                    let mut current = self.get_subscriptions(&message.conn_id)?;
                    current.sort_by_key(|sub| {
                        std::cmp::Reverse(received_topic_specificity(&sub.topic))
                    });
                    subscriptions.insert(message.conn_id.clone(), current);
                }
                let chosen = subscriptions[&message.conn_id]
                    .iter()
                    .find(|sub| received_topic_matches(&message.topic, &sub.topic))
                    .map(|sub| sub.format.as_str())
                    .filter(|format| !format.is_empty())
                    .unwrap_or(fallback)
                    .to_lowercase();
                let format = match chosen.as_str() {
                    "json" => "json",
                    "hex" => "hex",
                    _ => "text",
                };
                let payload = match format {
                    "hex" => message.payload_hex.to_uppercase(),
                    "json" => serde_json::from_str::<serde_json::Value>(&message.payload)
                        .and_then(|value| serde_json::to_string_pretty(&value))
                        .unwrap_or_else(|_| message.payload.clone()),
                    _ => message.payload.clone(),
                };
                rows.push(MessageInput {
                    connection_id: message.conn_id.clone(),
                    topic: message.topic.clone(),
                    payload,
                    direction: "in".into(),
                    qos: message.qos.into(),
                    retained: i64::from(message.retained),
                    format: format.into(),
                });
            }
            self.save_messages(&rows)
        })();
        if let Err(error) = &result {
            *self
                .received_history_error
                .lock()
                .map_err(|error| error.to_string())? = Some(error.clone());
        }
        result
    }

    pub fn save_messages(&self, rows: &[MessageInput]) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(database_error)?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO message_history (connection_id,topic,payload,direction,qos,retained,format,created_at)
                 VALUES (?,?,?,?,?,?,?,?)",
            ).map_err(database_error)?;
            for input in rows {
                statement
                    .execute(params![
                        input.connection_id,
                        input.topic,
                        input.payload,
                        input.direction,
                        input.qos,
                        input.retained,
                        input.format,
                        history_timestamp()
                    ])
                    .map_err(database_error)?;
            }
        }
        transaction.commit().map_err(database_error)
    }

    pub fn save_publish(&self, input: &PublishInput) -> Result<(), String> {
        self.lock()?.execute(
            "INSERT INTO publish_history (connection_id,topic,payload,qos,retained,created_at) VALUES (?,?,?,?,?,?)",
            params![input.connection_id, input.topic, input.payload, input.qos, input.retained, history_timestamp()],
        ).map_err(database_error)?;
        Ok(())
    }

    pub fn get_publish_history(
        &self,
        connection_id: &str,
        limit: i64,
    ) -> Result<Vec<PublishHistoryRow>, String> {
        let limit = if limit == 0 { 50 } else { limit.clamp(1, 500) };
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id,connection_id,topic,COALESCE(payload,''),COALESCE(qos,0),COALESCE(retained,0),COALESCE(created_at,'')
             FROM publish_history WHERE connection_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
        ).map_err(database_error)?;
        let rows = statement
            .query_map(params![connection_id, limit], |row| {
                Ok(PublishHistoryRow {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    topic: row.get(2)?,
                    payload: row.get(3)?,
                    qos: row.get(4)?,
                    retained: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(rows)
    }

    pub fn save_logs(&self, rows: &[LogInput]) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(database_error)?;
        {
            let mut statement = transaction
                .prepare(
                    "INSERT INTO logs (connection_id,time,level,msg,created_at) VALUES (?,?,?,?,?)",
                )
                .map_err(database_error)?;
            for input in rows {
                statement
                    .execute(params![
                        input.connection_id,
                        input.time,
                        input.level,
                        input.msg,
                        history_timestamp()
                    ])
                    .map_err(database_error)?;
            }
        }
        transaction.commit().map_err(database_error)
    }

    pub fn get_all_settings(&self) -> Result<HashMap<String, String>, String> {
        let connection = self.lock()?;
        let mut statement = connection
            .prepare("SELECT key,COALESCE(value,'') FROM settings ORDER BY key")
            .map_err(database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(database_error)?;
        let mut settings = HashMap::new();
        for row in rows {
            let (key, value) = row.map_err(database_error)?;
            settings.insert(key, value);
        }
        Ok(settings)
    }

    pub fn save_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.lock()?.execute(
            "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        ).map_err(database_error)?;
        Ok(())
    }

    fn normalized_filter(filter: &HistoryFilter) -> Result<(i64, i64, i64), String> {
        if !filter.direction.is_empty() && filter.direction != "in" && filter.direction != "out" {
            return Err("history direction must be in or out".into());
        }
        let page = filter.page.max(1);
        let page_size = if filter.page_size == 0 {
            100
        } else {
            filter.page_size.clamp(20, 500)
        };
        Ok((
            page,
            page_size,
            page.saturating_sub(1).saturating_mul(page_size),
        ))
    }

    fn escape_like(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    }

    fn push_like(
        parts: &mut Vec<String>,
        values: &mut Vec<Value>,
        columns: &[&str],
        keyword: &str,
    ) {
        if keyword.is_empty() {
            return;
        }
        parts.push(format!(
            "({})",
            columns
                .iter()
                .map(|column| format!("{column} LIKE ? ESCAPE '\\'"))
                .collect::<Vec<_>>()
                .join(" OR ")
        ));
        let pattern = Value::Text(format!("%{}%", Self::escape_like(keyword)));
        values.extend(std::iter::repeat_n(pattern, columns.len()));
    }

    fn normalize_hex_history_keyword(keyword: &str) -> Option<String> {
        let without_prefix = keyword
            .strip_prefix("0x")
            .or_else(|| keyword.strip_prefix("0X"))
            .unwrap_or(keyword);
        let compact = without_prefix
            .chars()
            .filter(|character| !character.is_whitespace() && *character != '\u{feff}')
            .collect::<String>();
        (!compact.is_empty()
            && compact
                .chars()
                .all(|character| character.is_ascii_hexdigit()))
        .then(|| compact.to_ascii_uppercase())
    }

    fn message_filter(filter: &HistoryFilter) -> (String, Vec<Value>) {
        let mut parts = Vec::new();
        let mut values = Vec::new();
        if !filter.conn_id.is_empty() {
            parts.push("connection_id=?".into());
            values.push(Value::Text(filter.conn_id.clone()));
        }
        if !filter.direction.is_empty() {
            parts.push("direction=?".into());
            values.push(Value::Text(filter.direction.clone()));
        }
        if !filter.topic.is_empty() {
            parts.push("topic LIKE ? ESCAPE '\\'".into());
            values.push(Value::Text(format!(
                "%{}%",
                Self::escape_like(&filter.topic)
            )));
        }
        let normalized_hex = Self::normalize_hex_history_keyword(&filter.keyword)
            .filter(|value| value != &filter.keyword.to_ascii_uppercase());
        if let Some(normalized_hex) = normalized_hex {
            parts.push(
                "(topic LIKE ? ESCAPE '\\' OR payload LIKE ? ESCAPE '\\' OR (format='hex' AND payload LIKE ? ESCAPE '\\'))"
                    .into(),
            );
            values.push(Value::Text(format!(
                "%{}%",
                Self::escape_like(&filter.keyword)
            )));
            values.push(Value::Text(format!(
                "%{}%",
                Self::escape_like(&filter.keyword)
            )));
            values.push(Value::Text(format!(
                "%{}%",
                Self::escape_like(&normalized_hex)
            )));
        } else {
            Self::push_like(
                &mut parts,
                &mut values,
                &["topic", "payload"],
                &filter.keyword,
            );
        }
        let sql = if parts.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", parts.join(" AND "))
        };
        (sql, values)
    }

    fn log_filter(filter: &HistoryFilter) -> (String, Vec<Value>) {
        let mut parts = Vec::new();
        let mut values = Vec::new();
        if !filter.conn_id.is_empty() {
            parts.push("connection_id=?".into());
            values.push(Value::Text(filter.conn_id.clone()));
        }
        if !filter.level.is_empty() {
            parts.push("level=?".into());
            values.push(Value::Text(filter.level.clone()));
        }
        Self::push_like(&mut parts, &mut values, &["level", "msg"], &filter.keyword);
        let sql = if parts.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", parts.join(" AND "))
        };
        (sql, values)
    }

    pub fn query_history_messages(
        &self,
        filter: &HistoryFilter,
    ) -> Result<HistoryPage<MessageHistoryRow>, String> {
        let (page, page_size, offset) = Self::normalized_filter(filter)?;
        let (where_sql, values) = Self::message_filter(filter);
        let connection = self.lock()?;
        let total = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM message_history{where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let mut paged_values = values;
        paged_values.extend([Value::Integer(page_size), Value::Integer(offset)]);
        let mut statement = connection.prepare(&format!(
            "SELECT id,COALESCE(connection_id,''),topic,COALESCE(payload,''),direction,COALESCE(qos,0),
                    COALESCE(retained,0),COALESCE(format,'text'),COALESCE(created_at,'')
             FROM message_history{where_sql} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?"
        )).map_err(database_error)?;
        let rows = statement
            .query_map(params_from_iter(paged_values.iter()), |row| {
                Ok(MessageHistoryRow {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    topic: row.get(2)?,
                    payload: row.get(3)?,
                    direction: row.get(4)?,
                    qos: row.get(5)?,
                    retained: row.get(6)?,
                    format: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(HistoryPage {
            rows,
            total,
            page,
            page_size,
        })
    }

    pub fn query_history_logs(
        &self,
        filter: &HistoryFilter,
    ) -> Result<HistoryPage<LogHistoryRow>, String> {
        let (page, page_size, offset) = Self::normalized_filter(filter)?;
        let (where_sql, values) = Self::log_filter(filter);
        let connection = self.lock()?;
        let total = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM logs{where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .map_err(database_error)?;
        let mut paged_values = values;
        paged_values.extend([Value::Integer(page_size), Value::Integer(offset)]);
        let mut statement = connection.prepare(&format!(
            "SELECT id,COALESCE(connection_id,''),COALESCE(time,''),COALESCE(level,''),COALESCE(msg,''),COALESCE(created_at,'')
             FROM logs{where_sql} ORDER BY created_at DESC,time DESC,id DESC LIMIT ? OFFSET ?"
        )).map_err(database_error)?;
        let rows = statement
            .query_map(params_from_iter(paged_values.iter()), |row| {
                Ok(LogHistoryRow {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    time: row.get(2)?,
                    level: row.get(3)?,
                    msg: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        Ok(HistoryPage {
            rows,
            total,
            page,
            page_size,
        })
    }

    pub fn delete_history_message(&self, id: i64) -> Result<(), String> {
        self.lock()?
            .execute("DELETE FROM message_history WHERE id=?", [id])
            .map_err(database_error)?;
        Ok(())
    }

    pub fn delete_history_log(&self, id: i64) -> Result<(), String> {
        self.lock()?
            .execute("DELETE FROM logs WHERE id=?", [id])
            .map_err(database_error)?;
        Ok(())
    }

    pub fn clear_history_messages(&self, filter: &HistoryFilter) -> Result<(), String> {
        Self::normalized_filter(filter)?;
        let (where_sql, values) = Self::message_filter(filter);
        self.lock()?
            .execute(
                &format!("DELETE FROM message_history{where_sql}"),
                params_from_iter(values.iter()),
            )
            .map_err(database_error)?;
        Ok(())
    }

    pub fn clear_history_logs(&self, filter: &HistoryFilter) -> Result<(), String> {
        Self::normalized_filter(filter)?;
        let (where_sql, values) = Self::log_filter(filter);
        self.lock()?
            .execute(
                &format!("DELETE FROM logs{where_sql}"),
                params_from_iter(values.iter()),
            )
            .map_err(database_error)?;
        Ok(())
    }

    fn file_size(path: &Path) -> Result<u64, String> {
        match fs::metadata(path) {
            Ok(metadata) => Ok(metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn get_storage_stats(&self) -> Result<StorageStats, String> {
        let connection = self.lock()?;
        let message_count = connection
            .query_row("SELECT COUNT(*) FROM message_history", [], |row| row.get(0))
            .map_err(database_error)?;
        let log_count = connection
            .query_row("SELECT COUNT(*) FROM logs", [], |row| row.get(0))
            .map_err(database_error)?;
        let publish_count = connection
            .query_row("SELECT COUNT(*) FROM publish_history", [], |row| row.get(0))
            .map_err(database_error)?;
        drop(connection);
        let database_bytes = Self::file_size(&self.path)?;
        let wal_bytes = Self::file_size(&PathBuf::from(format!("{}-wal", self.path.display())))?;
        let shm_bytes = Self::file_size(&PathBuf::from(format!("{}-shm", self.path.display())))?;
        Ok(StorageStats {
            message_count,
            log_count,
            publish_count,
            total_count: message_count + log_count + publish_count,
            database_bytes,
            wal_bytes,
            shm_bytes,
            total_bytes: database_bytes + wal_bytes + shm_bytes,
        })
    }

    pub fn get_schema_version(&self) -> Result<i64, String> {
        self.lock()?
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(database_error)
    }

    pub fn clear_history_storage(&self) -> Result<StorageStats, String> {
        {
            let mut connection = self.lock()?;
            let transaction = connection.transaction().map_err(database_error)?;
            transaction
                .execute_batch(
                    "DELETE FROM message_history; DELETE FROM logs; DELETE FROM publish_history;",
                )
                .map_err(database_error)?;
            transaction.commit().map_err(database_error)?;
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
                .map_err(database_error)?;
        }
        self.get_storage_stats()
    }
}

async fn spawn_blocking<T, F>(database: State<'_, Database>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Database) -> Result<T, String> + Send + 'static,
{
    let database = database.inner().clone();
    tokio::task::spawn_blocking(move || operation(database))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn db_get_connections(
    database: State<'_, Database>,
) -> Result<Vec<ConnectionRow>, String> {
    spawn_blocking(database, |database| database.get_connections()).await
}

#[tauri::command]
pub async fn db_save_connection(
    database: State<'_, Database>,
    conn: ConnectionInput,
) -> Result<(), String> {
    spawn_blocking(database, move |database| {
        database.save_connection(conn).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn db_delete_connection(database: State<'_, Database>, id: String) -> Result<(), String> {
    spawn_blocking(database, move |database| database.delete_connection(&id)).await
}

#[tauri::command]
pub async fn db_get_message_counts(
    database: State<'_, Database>,
) -> Result<Vec<MessageCountsRow>, String> {
    spawn_blocking(database, |database| database.get_message_counts()).await
}

#[tauri::command]
pub async fn db_get_subscriptions(
    database: State<'_, Database>,
    conn_id: String,
) -> Result<Vec<SubscriptionRow>, String> {
    spawn_blocking(database, move |database| {
        database.get_subscriptions(&conn_id)
    })
    .await
}

#[tauri::command]
pub async fn db_add_subscription(
    database: State<'_, Database>,
    sub: SubscriptionInput,
) -> Result<(), String> {
    spawn_blocking(database, move |database| {
        database.add_subscription(sub).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn db_remove_subscription(
    database: State<'_, Database>,
    id: String,
) -> Result<(), String> {
    spawn_blocking(database, move |database| database.remove_subscription(&id)).await
}

#[tauri::command]
pub async fn db_save_messages(
    database: State<'_, Database>,
    rows: Vec<MessageInput>,
) -> Result<(), String> {
    spawn_blocking(database, move |database| database.save_messages(&rows)).await
}

#[tauri::command]
pub async fn db_save_logs(
    database: State<'_, Database>,
    rows: Vec<LogInput>,
) -> Result<(), String> {
    spawn_blocking(database, move |database| database.save_logs(&rows)).await
}

#[tauri::command]
pub async fn db_query_history_messages(
    database: State<'_, Database>,
    filter: HistoryFilter,
) -> Result<HistoryPage<MessageHistoryRow>, String> {
    spawn_blocking(database, move |database| {
        database.query_history_messages(&filter)
    })
    .await
}

#[tauri::command]
pub async fn db_delete_history_message(
    database: State<'_, Database>,
    id: i64,
) -> Result<(), String> {
    spawn_blocking(database, move |database| {
        database.delete_history_message(id)
    })
    .await
}

#[tauri::command]
pub async fn db_clear_history_messages(
    database: State<'_, Database>,
    filter: HistoryFilter,
) -> Result<(), String> {
    spawn_blocking(database, move |database| {
        database.clear_history_messages(&filter)
    })
    .await
}

#[tauri::command]
pub async fn db_query_history_logs(
    database: State<'_, Database>,
    filter: HistoryFilter,
) -> Result<HistoryPage<LogHistoryRow>, String> {
    spawn_blocking(database, move |database| {
        database.query_history_logs(&filter)
    })
    .await
}

#[tauri::command]
pub async fn db_delete_history_log(database: State<'_, Database>, id: i64) -> Result<(), String> {
    spawn_blocking(database, move |database| database.delete_history_log(id)).await
}

#[tauri::command]
pub async fn db_clear_history_logs(
    database: State<'_, Database>,
    filter: HistoryFilter,
) -> Result<(), String> {
    spawn_blocking(database, move |database| {
        database.clear_history_logs(&filter)
    })
    .await
}

#[tauri::command]
pub async fn db_get_publish_history(
    database: State<'_, Database>,
    conn_id: String,
    limit: i64,
) -> Result<Vec<PublishHistoryRow>, String> {
    spawn_blocking(database, move |database| {
        database.get_publish_history(&conn_id, limit)
    })
    .await
}

#[tauri::command]
pub async fn db_save_publish(
    database: State<'_, Database>,
    msg: PublishInput,
) -> Result<(), String> {
    spawn_blocking(database, move |database| database.save_publish(&msg)).await
}

#[tauri::command]
pub async fn db_get_all_settings(
    database: State<'_, Database>,
) -> Result<HashMap<String, String>, String> {
    spawn_blocking(database, |database| database.get_all_settings()).await
}

#[tauri::command]
pub async fn db_save_setting(
    database: State<'_, Database>,
    key: String,
    value: String,
) -> Result<(), String> {
    spawn_blocking(database, move |database| {
        database.save_setting(&key, &value)
    })
    .await
}

#[tauri::command]
pub async fn db_get_storage_stats(database: State<'_, Database>) -> Result<StorageStats, String> {
    spawn_blocking(database, |database| database.get_storage_stats()).await
}

#[tauri::command]
pub async fn db_clear_history_storage(
    database: State<'_, Database>,
) -> Result<StorageStats, String> {
    spawn_blocking(database, |database| database.clear_history_storage()).await
}

#[cfg(test)]
#[path = "database/tests.rs"]
mod tests;
