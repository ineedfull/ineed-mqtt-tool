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

#[derive(Debug, Clone, PartialEq, Eq)]
enum DefaultSemantics {
    None,
    String(String),
    Sql(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ColumnSemantics {
    name: String,
    declared_type: String,
    not_null: i64,
    default: DefaultSemantics,
    primary_key: i64,
    hidden: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ForeignKeySemantics {
    id: i64,
    sequence: i64,
    table: String,
    from: String,
    to: Option<String>,
    on_update: String,
    on_delete: String,
    match_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TableSemantics {
    columns: Vec<ColumnSemantics>,
    foreign_keys: Vec<ForeignKeySemantics>,
    checks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexColumnSemantics {
    sequence: i64,
    name: Option<String>,
    expression_column_id: Option<i64>,
    collation: String,
    descending: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexSemantics {
    table: String,
    unique: i64,
    partial: i64,
    origin: String,
    columns: Vec<IndexColumnSemantics>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TriggerSemantics {
    name: String,
    table: String,
    sql: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SchemaSemantics {
    tables: BTreeMap<String, TableSemantics>,
    indexes: BTreeMap<String, IndexSemantics>,
    triggers: Vec<TriggerSemantics>,
}

fn normalize_default(value: Option<String>) -> DefaultSemantics {
    let Some(value) = value else {
        return DefaultSemantics::None;
    };
    let mut characters = value.chars();
    let Some(quote) = characters.next() else {
        return DefaultSemantics::Sql(value);
    };
    if (quote == '\'' || quote == '"') && value.ends_with(quote) && value.len() >= 2 {
        let inner = &value[quote.len_utf8()..value.len() - quote.len_utf8()];
        return DefaultSemantics::String(
            inner.replace(&format!("{quote}{quote}"), &quote.to_string()),
        );
    }
    DefaultSemantics::Sql(value)
}

fn quoted_sql_token(
    characters: &[char],
    start: usize,
    quote: char,
    string_literal: bool,
) -> Result<(usize, String), String> {
    let closing = if quote == '[' { ']' } else { quote };
    let mut cursor = start + 1;
    let mut value = String::new();
    while cursor < characters.len() {
        if characters[cursor] != closing {
            value.push(characters[cursor]);
            cursor += 1;
            continue;
        }
        if characters.get(cursor + 1) == Some(&closing) {
            value.push(closing);
            cursor += 2;
            continue;
        }
        let normalized = if string_literal {
            format!("STRING:{value:?}")
        } else {
            format!("WORD:{}", value.to_uppercase())
        };
        return Ok((cursor + 1, normalized));
    }
    Err("unterminated quoted SQL token in schema".into())
}

fn sql_tokens(sql: &str) -> Result<Vec<String>, String> {
    let characters = sql.chars().collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut cursor = 0;
    while cursor < characters.len() {
        let character = characters[cursor];
        if character.is_whitespace() {
            cursor += 1;
            continue;
        }
        if character == '-' && characters.get(cursor + 1) == Some(&'-') {
            cursor += 2;
            while cursor < characters.len() && characters[cursor] != '\n' {
                cursor += 1;
            }
            continue;
        }
        if character == '/' && characters.get(cursor + 1) == Some(&'*') {
            cursor += 2;
            while cursor + 1 < characters.len()
                && !(characters[cursor] == '*' && characters[cursor + 1] == '/')
            {
                cursor += 1;
            }
            if cursor + 1 >= characters.len() {
                return Err("unterminated SQL block comment in schema".into());
            }
            cursor += 2;
            continue;
        }
        if character == '\'' {
            let (next, token) = quoted_sql_token(&characters, cursor, character, true)?;
            tokens.push(token);
            cursor = next;
            continue;
        }
        if character == '"' || character == '`' || character == '[' {
            let (next, token) = quoted_sql_token(&characters, cursor, character, false)?;
            tokens.push(token);
            cursor = next;
            continue;
        }
        if character.is_ascii_alphabetic() || character == '_' || character == '$' {
            let start = cursor;
            cursor += 1;
            while cursor < characters.len()
                && (characters[cursor].is_ascii_alphanumeric()
                    || characters[cursor] == '_'
                    || characters[cursor] == '$')
            {
                cursor += 1;
            }
            tokens.push(format!(
                "WORD:{}",
                characters[start..cursor]
                    .iter()
                    .collect::<String>()
                    .to_uppercase()
            ));
            continue;
        }
        if character.is_ascii_digit()
            || (character == '.' && characters.get(cursor + 1).is_some_and(char::is_ascii_digit))
        {
            let start = cursor;
            if character == '0' && matches!(characters.get(cursor + 1), Some('x' | 'X')) {
                cursor += 2;
                while cursor < characters.len() && characters[cursor].is_ascii_hexdigit() {
                    cursor += 1;
                }
            } else {
                while cursor < characters.len() && characters[cursor].is_ascii_digit() {
                    cursor += 1;
                }
                if characters.get(cursor) == Some(&'.') {
                    cursor += 1;
                    while cursor < characters.len() && characters[cursor].is_ascii_digit() {
                        cursor += 1;
                    }
                }
                if matches!(characters.get(cursor), Some('e' | 'E')) {
                    cursor += 1;
                    if matches!(characters.get(cursor), Some('+' | '-')) {
                        cursor += 1;
                    }
                    while cursor < characters.len() && characters[cursor].is_ascii_digit() {
                        cursor += 1;
                    }
                }
            }
            tokens.push(format!(
                "NUMBER:{}",
                characters[start..cursor]
                    .iter()
                    .collect::<String>()
                    .to_uppercase()
            ));
            continue;
        }

        let remaining = characters[cursor..].iter().collect::<String>();
        if remaining.starts_with("->>") {
            tokens.push("OP:->>".into());
            cursor += 3;
            continue;
        }
        let pair = characters
            .get(cursor + 1)
            .map(|next| format!("{character}{next}"));
        if let Some(pair) = pair.filter(|pair| {
            ["!=", "<>", "==", "<=", ">=", "||", "<<", ">>", "->"].contains(&pair.as_str())
        }) {
            let equivalent = match pair.as_str() {
                "!=" => "<>",
                "==" => "=",
                _ => &pair,
            };
            tokens.push(format!("OP:{equivalent}"));
            cursor += 2;
            continue;
        }
        if character == '(' || character == ')' {
            tokens.push(character.to_string());
        } else if "=<>+-*/%,.&|~".contains(character) {
            tokens.push(format!("OP:{character}"));
        } else {
            tokens.push(format!("PUNCT:{character}"));
        }
        cursor += 1;
    }
    Ok(tokens)
}

fn wrapped_by_parentheses(tokens: &[String]) -> bool {
    if tokens.len() < 2
        || tokens.first().map(String::as_str) != Some("(")
        || tokens.last().map(String::as_str) != Some(")")
    {
        return false;
    }
    let mut depth = 0;
    for (index, token) in tokens.iter().enumerate() {
        if token == "(" {
            depth += 1;
        } else if token == ")" {
            depth -= 1;
        }
        if depth == 0 && index < tokens.len() - 1 {
            return false;
        }
    }
    depth == 0
}

fn check_constraint_semantics(sql: &str) -> Result<Vec<String>, String> {
    let tokens = sql_tokens(sql)?;
    let mut checks = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if tokens[index] != "WORD:CHECK" {
            index += 1;
            continue;
        }
        if tokens.get(index + 1).map(String::as_str) != Some("(") {
            return Err("CHECK constraint is missing an opening parenthesis".into());
        }
        let mut depth = 1;
        let mut expression = Vec::new();
        let mut cursor = index + 2;
        while cursor < tokens.len() && depth > 0 {
            if tokens[cursor] == "(" {
                depth += 1;
            } else if tokens[cursor] == ")" {
                depth -= 1;
            }
            if depth > 0 {
                expression.push(tokens[cursor].clone());
            }
            cursor += 1;
        }
        if depth != 0 {
            return Err("CHECK constraint has unbalanced parentheses".into());
        }
        while wrapped_by_parentheses(&expression) {
            expression = expression[1..expression.len() - 1].to_vec();
        }
        checks.push(expression.join(" "));
        index = cursor;
    }
    checks.sort();
    Ok(checks)
}

fn table_semantics(connection: &Connection, table: &str) -> Result<TableSemantics, String> {
    let columns = {
        let mut statement = connection
            .prepare(
                "SELECT name,type,\"notnull\",dflt_value,pk,hidden
                 FROM pragma_table_xinfo(?) ORDER BY name",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([table], |row| {
                Ok(ColumnSemantics {
                    name: row.get(0)?,
                    declared_type: row.get::<_, String>(1)?.trim().to_uppercase(),
                    not_null: row.get(2)?,
                    default: normalize_default(row.get(3)?),
                    primary_key: row.get(4)?,
                    hidden: row.get(5)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };
    let foreign_keys = {
        let mut statement = connection
            .prepare(
                "SELECT id,seq,\"table\",\"from\",\"to\",on_update,on_delete,\"match\"
                 FROM pragma_foreign_key_list(?) ORDER BY id,seq",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([table], |row| {
                Ok(ForeignKeySemantics {
                    id: row.get(0)?,
                    sequence: row.get(1)?,
                    table: row.get(2)?,
                    from: row.get(3)?,
                    to: row.get(4)?,
                    on_update: row.get(5)?,
                    on_delete: row.get(6)?,
                    match_type: row.get(7)?,
                })
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        rows
    };
    let definition: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",
            [table],
            |row| row.get(0),
        )
        .or_else(|error| {
            if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
                Ok(None)
            } else {
                Err(error)
            }
        })
        .map_err(database_error)?;
    let checks = check_constraint_semantics(definition.as_deref().unwrap_or(""))?;
    Ok(TableSemantics {
        columns,
        foreign_keys,
        checks,
    })
}

fn schema_semantics(connection: &Connection) -> Result<SchemaSemantics, String> {
    let mut tables = BTreeMap::new();
    for table in REQUIRED_TABLES {
        tables.insert((*table).to_string(), table_semantics(connection, table)?);
    }

    let mut indexes = BTreeMap::new();
    for table in REQUIRED_TABLES {
        let mut statement = connection
            .prepare(
                "SELECT name,\"unique\",origin,partial FROM pragma_index_list(?) ORDER BY name",
            )
            .map_err(database_error)?;
        let listed = statement
            .query_map([table], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(database_error)?;
        for (name, unique, origin, partial) in listed {
            if unique == 0 && !REQUIRED_INDEXES.contains(&name.as_str()) {
                continue;
            }
            let mut column_statement = connection
                .prepare(
                    "SELECT seqno,cid,name,coll,desc FROM pragma_index_xinfo(?)
                     WHERE key=1 ORDER BY seqno",
                )
                .map_err(database_error)?;
            let columns = column_statement
                .query_map([&name], |row| {
                    let column_name = row.get::<_, Option<String>>(2)?;
                    Ok(IndexColumnSemantics {
                        sequence: row.get(0)?,
                        expression_column_id: column_name
                            .is_none()
                            .then(|| row.get(1))
                            .transpose()?,
                        name: column_name,
                        collation: row.get(3)?,
                        descending: row.get(4)?,
                    })
                })
                .map_err(database_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(database_error)?;
            indexes.insert(
                name,
                IndexSemantics {
                    table: (*table).to_string(),
                    unique,
                    partial,
                    origin,
                    columns,
                },
            );
        }
    }

    let mut trigger_statement = connection
        .prepare("SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")
        .map_err(database_error)?;
    let triggers = trigger_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(database_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error)?
        .into_iter()
        .map(|(name, table, sql)| {
            Ok(TriggerSemantics {
                name,
                table,
                sql: sql_tokens(&sql)?.join(" "),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(SchemaSemantics {
        tables,
        indexes,
        triggers,
    })
}

fn validate_required_schema(connection: &Connection) -> Result<(), String> {
    let canonical = Connection::open_in_memory().map_err(database_error)?;
    canonical
        .execute_batch(BASELINE_SCHEMA)
        .map_err(database_error)?;
    let expected = schema_semantics(&canonical)?;
    let actual = schema_semantics(connection)?;
    for table in REQUIRED_TABLES {
        let expected_table = expected
            .tables
            .get(*table)
            .ok_or_else(|| format!("canonical schema is missing table semantics for {table}"))?;
        let actual_table = actual
            .tables
            .get(*table)
            .ok_or_else(|| format!("database schema is missing table semantics for {table}"))?;
        if actual_table.columns != expected_table.columns {
            return Err(format!(
                "database schema mismatch: {table} columns differ from persistence contract"
            ));
        }
        if actual_table.foreign_keys != expected_table.foreign_keys {
            return Err(format!(
                "database schema mismatch: {table} foreign keys differ from persistence contract"
            ));
        }
        if actual_table.checks != expected_table.checks {
            return Err(format!("database schema mismatch: {table} CHECK constraints differ from persistence contract"));
        }
    }
    if actual.indexes != expected.indexes {
        return Err(
            "database schema mismatch: constrained indexes differ from persistence contract".into(),
        );
    }
    if actual.triggers != expected.triggers {
        return Err("database schema mismatch: triggers differ from persistence contract".into());
    }
    Ok(())
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
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;

    struct TempDatabase {
        path: PathBuf,
    }

    impl TempDatabase {
        fn new(label: &str) -> Self {
            Self {
                path: std::env::temp_dir().join(format!(
                    "ineed-mqtt-{label}-{}-{}.db",
                    std::process::id(),
                    Uuid::new_v4()
                )),
            }
        }

        fn copy_fixture() -> Self {
            let temporary = Self::new("fixture");
            fs::copy("../tests/fixtures/current-tauri.db", &temporary.path).expect("copy fixture");
            temporary
        }
    }

    impl Drop for TempDatabase {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = fs::remove_file(format!("{}{suffix}", self.path.display()));
            }
        }
    }

    fn connection_input(id: &str) -> ConnectionInput {
        ConnectionInput {
            id: id.into(),
            name: "Local broker".into(),
            host: "localhost".into(),
            port: Some(1883),
            protocol: "mqtt".into(),
            path: String::new(),
            client_id: "test-client".into(),
            username: String::new(),
            password: String::new(),
            ssl: 0,
            keepalive: Some(60),
            clean_session: Some(1),
            sort_order: 1,
        }
    }

    fn message(topic: &str, payload: &str, direction: &str) -> MessageInput {
        MessageInput {
            connection_id: "conn-tauri-fixture".into(),
            topic: topic.into(),
            payload: payload.into(),
            direction: direction.into(),
            qos: 1,
            retained: 0,
            format: "text".into(),
        }
    }

    fn log(time: &str, level: &str, msg: &str) -> LogInput {
        LogInput {
            connection_id: "conn-tauri-fixture".into(),
            time: time.into(),
            level: level.into(),
            msg: msg.into(),
        }
    }

    fn create_schema_database(label: &str, schema: &str, user_version: i64) -> TempDatabase {
        let temporary = TempDatabase::new(label);
        let connection = Connection::open(&temporary.path).expect("create schema database");
        connection
            .execute_batch(schema)
            .expect("create test schema");
        connection
            .pragma_update(None, "user_version", user_version)
            .expect("set test schema version");
        connection
            .execute(
                "INSERT INTO connections (id,name,host) VALUES ('schema-sentinel','Sentinel','localhost')",
                [],
            )
            .expect("insert schema sentinel");
        drop(connection);
        temporary
    }

    fn replace_once(schema: &str, from: &str, to: &str) -> String {
        assert!(schema.contains(from), "canonical schema contains {from}");
        schema.replacen(from, to, 1)
    }

    #[test]
    fn rejects_incompatible_schema_semantics_and_rolls_back_version_and_data() {
        let variants = [
            (
                "wrong-type",
                replace_once(BASELINE_SCHEMA, "host TEXT NOT NULL", "host BLOB NOT NULL"),
            ),
            (
                "wrong-default",
                replace_once(
                    BASELINE_SCHEMA,
                    "port INTEGER DEFAULT 1883",
                    "port INTEGER DEFAULT 9999",
                ),
            ),
            (
                "wrong-primary-key",
                replace_once(BASELINE_SCHEMA, "id TEXT PRIMARY KEY", "id TEXT"),
            ),
            (
                "missing-required-column",
                replace_once(BASELINE_SCHEMA, "  sort_order INTEGER DEFAULT 0,\n", ""),
            ),
            (
                "missing-foreign-key",
                replace_once(
                    BASELINE_SCHEMA,
                    "connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,",
                    "connection_id TEXT,",
                ),
            ),
            (
                "missing-check",
                replace_once(
                    BASELINE_SCHEMA,
                    "direction TEXT CHECK (direction IN ('in', 'out'))",
                    "direction TEXT",
                ),
            ),
            (
                "different-check",
                replace_once(
                    BASELINE_SCHEMA,
                    "direction TEXT CHECK (direction IN ('in', 'out'))",
                    "direction TEXT CHECK (direction <> 'invalid')",
                ),
            ),
            (
                "additional-check",
                replace_once(
                    BASELINE_SCHEMA,
                    "direction TEXT CHECK (direction IN ('in', 'out'))",
                    "direction TEXT CHECK (direction IN ('in', 'out')) CHECK (length(topic) > 0)",
                ),
            ),
            (
                "wrong-required-index",
                replace_once(
                    BASELINE_SCHEMA,
                    "ON message_history (connection_id, created_at, id)",
                    "ON message_history (topic, created_at, id)",
                ),
            ),
            (
                "extra-unique-index",
                format!(
                    "{BASELINE_SCHEMA}\nCREATE UNIQUE INDEX extra_unique_topic ON message_history(topic);"
                ),
            ),
            (
                "extra-trigger",
                format!(
                    "{BASELINE_SCHEMA}\nCREATE TRIGGER extra_message_trigger AFTER INSERT ON message_history BEGIN UPDATE message_history SET topic=upper(topic) WHERE id=NEW.id; END;"
                ),
            ),
        ];

        for (label, schema) in variants {
            let temporary = create_schema_database(label, &schema, 0);
            let error = Database::open(&temporary.path)
                .err()
                .expect("reject incompatible schema");
            assert!(error.contains("schema"), "{label}: {error}");

            let inspector = Connection::open(&temporary.path).expect("inspect rejected database");
            let version: i64 = inspector
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .expect("read rolled back version");
            let sentinel_count: i64 = inspector
                .query_row(
                    "SELECT COUNT(*) FROM connections WHERE id='schema-sentinel'",
                    [],
                    |row| row.get(0),
                )
                .expect("read preserved sentinel");
            assert_eq!(version, 0, "{label}");
            assert_eq!(sentinel_count, 1, "{label}");
        }

        let malformed_legacy = replace_once(
            &replace_once(BASELINE_SCHEMA, "host TEXT NOT NULL", "host BLOB NOT NULL"),
            "  format TEXT DEFAULT '',\n",
            "",
        );
        let temporary = create_schema_database("rollback-additive-migration", &malformed_legacy, 0);
        assert!(Database::open(&temporary.path).is_err());
        let inspector = Connection::open(&temporary.path).expect("inspect rolled back migration");
        assert!(!has_column(&inspector, "message_history", "format").expect("format column"));
    }

    #[test]
    fn accepts_token_equivalent_checks_and_extra_non_unique_indexes() {
        let schema = replace_once(
            BASELINE_SCHEMA,
            "direction TEXT CHECK (direction IN ('in', 'out'))",
            "direction TEXT CHECK ( /* ) */ ((\"direction\" in ('in', 'out'))))",
        );
        let schema =
            format!("{schema}\nCREATE INDEX extra_message_topic ON message_history(topic);");
        let temporary = create_schema_database("compatible-extension", &schema, 1);

        let database = Database::open(&temporary.path).expect("accept compatible schema");
        drop(database);
        Database::open(&temporary.path).expect("idempotent compatible reopen");
    }

    #[test]
    fn opens_current_fixture_and_reopens_idempotently_without_losing_rows() {
        let temporary = TempDatabase::copy_fixture();
        let database = Database::open(&temporary.path).expect("open fixture");

        assert_eq!(database.get_connections().expect("connections").len(), 1);
        assert_eq!(
            database
                .get_subscriptions("conn-tauri-fixture")
                .expect("subscriptions")
                .len(),
            1
        );
        assert_eq!(
            database.get_message_counts().expect("counts")[0].messages_in,
            1
        );
        assert_eq!(
            database
                .get_publish_history("conn-tauri-fixture", 10)
                .expect("publishes")[0]
                .payload,
            "published payload"
        );
        assert_eq!(
            database
                .get_all_settings()
                .expect("settings")
                .get("theme")
                .map(String::as_str),
            Some("dark")
        );
        drop(database);

        let reopened = Database::open(&temporary.path).expect("reopen fixture");
        assert_eq!(reopened.get_storage_stats().expect("stats").total_count, 3);
        assert_eq!(
            reopened.get_connections().expect("connections")[0].id,
            "conn-tauri-fixture"
        );
    }

    #[test]
    fn migrates_additive_legacy_columns_and_indexes_without_replacing_data() {
        let temporary = TempDatabase::new("legacy");
        let connection = Connection::open(&temporary.path).expect("create legacy database");
        let legacy_schema = BASELINE_SCHEMA
            .replacen(
                "  color TEXT DEFAULT '',\n  format TEXT DEFAULT 'json',\n",
                "",
                1,
            )
            .replacen("  format TEXT DEFAULT '',\n", "", 1);
        connection
            .execute_batch(&legacy_schema)
            .expect("legacy schema");
        connection.execute_batch(
            "INSERT INTO connections (id,name,host) VALUES ('legacy','Legacy','localhost');
             INSERT INTO subscriptions (id,connection_id,topic) VALUES ('legacy-sub','legacy','legacy/#');
             INSERT INTO message_history (connection_id,topic,direction) VALUES ('legacy','legacy/topic','in');",
        ).expect("legacy schema");
        drop(connection);

        let database = Database::open(&temporary.path).expect("migrate legacy database");
        assert_eq!(
            database.get_connections().expect("connections")[0].id,
            "legacy"
        );
        let connection = database.lock().expect("database lock");
        for (table, column) in [
            ("subscriptions", "color"),
            ("subscriptions", "format"),
            ("message_history", "format"),
        ] {
            assert!(has_column(&connection, table, column).expect("column lookup"));
        }
        for index in ["idx_message_history_conn_time_id", "idx_logs_conn_time_id"] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type='index' AND name=?",
                    [index],
                    |row| row.get(0),
                )
                .expect("index lookup");
            assert_eq!(count, 1, "{index}");
        }
    }

    #[test]
    fn history_messages_and_logs_return_real_filtered_second_pages_in_stable_order() {
        let temporary = TempDatabase::copy_fixture();
        let database = Database::open(&temporary.path).expect("open fixture");
        database
            .save_messages(
                &(1..=21)
                    .map(|value| {
                        message(
                            &format!("page/{value:02}"),
                            &format!("needle {value}"),
                            "out",
                        )
                    })
                    .collect::<Vec<_>>(),
            )
            .expect("save messages");
        database
            .save_logs(
                &(1..=21)
                    .map(|value| {
                        log(
                            &format!("04:00:{value:02}"),
                            "warn",
                            &format!("needle {value}"),
                        )
                    })
                    .collect::<Vec<_>>(),
            )
            .expect("save logs");

        let filter = HistoryFilter {
            conn_id: "conn-tauri-fixture".into(),
            direction: "out".into(),
            keyword: "needle".into(),
            page: 2,
            page_size: 20,
            ..HistoryFilter::default()
        };
        let messages = database
            .query_history_messages(&filter)
            .expect("query messages");
        assert_eq!(
            (messages.total, messages.page, messages.page_size),
            (21, 2, 20)
        );
        assert_eq!(
            messages
                .rows
                .iter()
                .map(|row| row.topic.as_str())
                .collect::<Vec<_>>(),
            ["page/01"]
        );

        let logs = database
            .query_history_logs(&HistoryFilter {
                conn_id: "conn-tauri-fixture".into(),
                level: "warn".into(),
                keyword: "needle".into(),
                page: 2,
                page_size: 20,
                ..HistoryFilter::default()
            })
            .expect("query logs");
        assert_eq!((logs.total, logs.page, logs.page_size), (21, 2, 20));
        assert_eq!(
            logs.rows
                .iter()
                .map(|row| row.msg.as_str())
                .collect::<Vec<_>>(),
            ["needle 1"]
        );
        let serialized = serde_json::to_value(&logs).expect("serialize page");
        assert_eq!(serialized["pageSize"], 20);
        assert!(serialized["rows"][0].get("connection_id").is_some());
    }

    #[test]
    fn like_filters_treat_percent_underscore_and_backslash_as_literals() {
        let temporary = TempDatabase::copy_fixture();
        let database = Database::open(&temporary.path).expect("open fixture");
        database
            .save_messages(&[
                message("metrics/100%/cpu", "percent", "in"),
                message("metrics/1000/cpu", "percent decoy", "in"),
                message("metrics/a_b", r"path\root", "in"),
                message("metrics/acb", "pathroot", "in"),
            ])
            .expect("save messages");
        database
            .save_logs(&[
                log("04:10:00", "info", r"100% under_score path\root"),
                log("04:10:01", "info", "1000 underXscore pathroot"),
            ])
            .expect("save logs");

        for (filter, expected) in [
            (
                HistoryFilter {
                    topic: "100%".into(),
                    ..HistoryFilter::default()
                },
                "metrics/100%/cpu",
            ),
            (
                HistoryFilter {
                    topic: "a_b".into(),
                    ..HistoryFilter::default()
                },
                "metrics/a_b",
            ),
            (
                HistoryFilter {
                    keyword: r"path\root".into(),
                    ..HistoryFilter::default()
                },
                "metrics/a_b",
            ),
        ] {
            let page = database
                .query_history_messages(&filter)
                .expect("literal LIKE query");
            assert_eq!(
                page.rows
                    .iter()
                    .map(|row| row.topic.as_str())
                    .collect::<Vec<_>>(),
                [expected]
            );
        }
        for keyword in ["100%", "under_score", r"path\root"] {
            let page = database
                .query_history_logs(&HistoryFilter {
                    keyword: keyword.into(),
                    ..HistoryFilter::default()
                })
                .expect("literal log LIKE query");
            assert_eq!(page.rows.len(), 1, "{keyword}");
            assert_eq!(page.rows[0].msg, r"100% under_score path\root");
        }
    }

    #[test]
    fn message_hex_keywords_match_and_clear_compact_payloads_with_electron_semantics() {
        let temporary = TempDatabase::copy_fixture();
        let database = Database::open(&temporary.path).expect("open fixture");
        let mut hex = message("hex/compact", "AABBCCDD", "in");
        hex.format = "hex".into();
        let mut odd_hex = message("hex/odd", "00AAB11", "in");
        odd_hex.format = "hex".into();
        database
            .save_messages(&[
                hex,
                odd_hex,
                message("text/compact", "AABBCCDD", "in"),
                message("text/invalid", "AA GG", "in"),
                message("text/leading-prefix", " 0xAA BB", "in"),
                message("text/plain", "ordinary UTF8 payload", "in"),
            ])
            .expect("save HEX search fixtures");

        for keyword in ["aa bb", "0xAa bB", "AA\tBB", "AA\nBB"] {
            let page = database
                .query_history_messages(&HistoryFilter {
                    keyword: keyword.into(),
                    ..HistoryFilter::default()
                })
                .expect("query compact HEX");
            let topics = page
                .rows
                .iter()
                .map(|row| row.topic.as_str())
                .collect::<Vec<_>>();
            if keyword.contains(' ') {
                assert_eq!(
                    topics,
                    ["text/leading-prefix", "hex/compact"],
                    "{keyword:?}"
                );
            } else {
                assert_eq!(topics, ["hex/compact"], "{keyword:?}");
            }
        }
        assert_eq!(
            database
                .query_history_messages(&HistoryFilter {
                    keyword: "A AB".into(),
                    ..HistoryFilter::default()
                })
                .expect("odd HEX query")
                .rows[0]
                .topic,
            "hex/odd"
        );
        for (keyword, expected) in [
            ("AA GG", "text/invalid"),
            (" 0xAA BB", "text/leading-prefix"),
            ("ordinary UTF8", "text/plain"),
        ] {
            let page = database
                .query_history_messages(&HistoryFilter {
                    keyword: keyword.into(),
                    ..HistoryFilter::default()
                })
                .expect("literal message query");
            assert_eq!(page.rows[0].topic, expected, "{keyword:?}");
        }

        database
            .clear_history_messages(&HistoryFilter {
                keyword: "0xAA BB".into(),
                ..HistoryFilter::default()
            })
            .expect("clear compact HEX only");
        assert_eq!(
            database
                .query_history_messages(&HistoryFilter {
                    topic: "hex/compact".into(),
                    ..HistoryFilter::default()
                })
                .expect("cleared HEX row")
                .total,
            0
        );
        assert_eq!(
            database
                .query_history_messages(&HistoryFilter {
                    topic: "text/compact".into(),
                    ..HistoryFilter::default()
                })
                .expect("preserved text row")
                .total,
            1
        );
    }

    #[test]
    fn every_history_query_and_clear_rejects_invalid_direction_without_deleting_rows() {
        let temporary = TempDatabase::copy_fixture();
        let database = Database::open(&temporary.path).expect("open fixture");
        let filter = HistoryFilter {
            direction: "sideways".into(),
            ..HistoryFilter::default()
        };
        let before = database
            .get_storage_stats()
            .expect("stats before invalid clears");

        assert!(database.query_history_messages(&filter).is_err());
        assert!(database.query_history_logs(&filter).is_err());
        assert!(database.clear_history_messages(&filter).is_err());
        assert!(database.clear_history_logs(&filter).is_err());

        let after = database
            .get_storage_stats()
            .expect("stats after invalid clears");
        assert_eq!(after.message_count, before.message_count);
        assert_eq!(after.log_count, before.log_count);
    }

    #[test]
    fn connection_input_defaults_missing_values_and_preserves_explicit_non_positive_values() {
        let temporary = TempDatabase::new("connection-input-defaults");
        let database = Database::open(&temporary.path).expect("open database");
        let missing: ConnectionInput = serde_json::from_value(serde_json::json!({
            "id": "conn-missing-defaults",
            "name": "Missing defaults",
            "host": "localhost"
        }))
        .expect("deserialize missing defaults");
        database
            .save_connection(missing)
            .expect("save missing defaults");

        let explicit: ConnectionInput = serde_json::from_value(serde_json::json!({
            "id": "conn-explicit-values",
            "name": "Explicit values",
            "host": "localhost",
            "port": 0,
            "keepalive": -5,
            "clean_session": 0
        }))
        .expect("deserialize explicit values");
        database
            .save_connection(explicit)
            .expect("save explicit values");

        let rows = database.get_connections().expect("connections");
        let missing = rows
            .iter()
            .find(|row| row.id == "conn-missing-defaults")
            .expect("missing defaults row");
        assert_eq!(
            (missing.port, missing.keepalive, missing.clean_session),
            (1883, 60, 1)
        );
        let explicit = rows
            .iter()
            .find(|row| row.id == "conn-explicit-values")
            .expect("explicit values row");
        assert_eq!(
            (explicit.port, explicit.keepalive, explicit.clean_session),
            (0, -5, 0)
        );
    }

    #[test]
    fn clamps_invalid_pages_page_sizes_and_publish_limits() {
        let temporary = TempDatabase::copy_fixture();
        let database = Database::open(&temporary.path).expect("open fixture");
        let page = database
            .query_history_messages(&HistoryFilter {
                page: -10,
                page_size: 1,
                ..HistoryFilter::default()
            })
            .expect("clamped history query");
        assert_eq!((page.page, page.page_size), (1, 20));
        database
            .save_publish(&PublishInput {
                connection_id: "conn-tauri-fixture".into(),
                topic: "publish/newest".into(),
                payload: "new".into(),
                qos: 2,
                retained: 0,
            })
            .expect("save publish");
        assert_eq!(
            database
                .get_publish_history("conn-tauri-fixture", 1)
                .expect("limited publish history")[0]
                .topic,
            "publish/newest"
        );
        assert_eq!(
            database
                .get_publish_history("conn-tauri-fixture", -1)
                .expect("fallback limit")
                .len(),
            1
        );
        assert!(database
            .query_history_messages(&HistoryFilter {
                direction: "sideways".into(),
                ..HistoryFilter::default()
            })
            .is_err());
    }

    #[test]
    fn batch_message_transaction_rolls_back_on_constraint_failure() {
        let temporary = TempDatabase::copy_fixture();
        let database = Database::open(&temporary.path).expect("open fixture");
        let before = database.get_storage_stats().expect("stats").message_count;
        let result = database.save_messages(&[
            message("batch/valid", "valid", "in"),
            message("batch/invalid", "invalid", "sideways"),
        ]);
        assert!(result.is_err());
        assert_eq!(
            database.get_storage_stats().expect("stats").message_count,
            before
        );
    }

    #[test]
    fn delete_single_rows_clear_filters_and_connection_delete_cascades() {
        let temporary = TempDatabase::copy_fixture();
        let database = Database::open(&temporary.path).expect("open fixture");
        database
            .save_messages(&[
                message("keep/topic", "keep", "in"),
                message("clear/topic", "clear", "out"),
            ])
            .expect("save messages");
        database
            .save_logs(&[
                log("04:01:00", "info", "keep"),
                log("04:02:00", "warn", "clear"),
            ])
            .expect("save logs");

        let message_id = database
            .query_history_messages(&HistoryFilter {
                topic: "keep/topic".into(),
                ..HistoryFilter::default()
            })
            .expect("message")
            .rows[0]
            .id;
        let log_id = database
            .query_history_logs(&HistoryFilter {
                keyword: "keep".into(),
                ..HistoryFilter::default()
            })
            .expect("log")
            .rows[0]
            .id;
        database
            .delete_history_message(message_id)
            .expect("delete message");
        database.delete_history_log(log_id).expect("delete log");
        database
            .clear_history_messages(&HistoryFilter {
                direction: "out".into(),
                ..HistoryFilter::default()
            })
            .expect("clear messages");
        database
            .clear_history_logs(&HistoryFilter {
                level: "warn".into(),
                ..HistoryFilter::default()
            })
            .expect("clear logs");
        assert_eq!(
            database
                .query_history_messages(&HistoryFilter {
                    keyword: "clear".into(),
                    ..HistoryFilter::default()
                })
                .expect("messages")
                .total,
            0
        );
        assert_eq!(
            database
                .query_history_logs(&HistoryFilter {
                    keyword: "clear".into(),
                    ..HistoryFilter::default()
                })
                .expect("logs")
                .total,
            0
        );

        database
            .delete_connection("conn-tauri-fixture")
            .expect("delete connection");
        assert!(database
            .get_subscriptions("conn-tauri-fixture")
            .expect("subscriptions")
            .is_empty());
        assert!(database
            .get_publish_history("conn-tauri-fixture", 10)
            .expect("publishes")
            .is_empty());
    }

    #[test]
    fn clear_history_storage_preserves_configuration_and_accepts_new_writes() {
        let temporary = TempDatabase::copy_fixture();
        let database = Database::open(&temporary.path).expect("open fixture");
        let stats = database.clear_history_storage().expect("clear storage");
        assert_eq!(stats.total_count, 0);
        assert_eq!(database.get_connections().expect("connections").len(), 1);
        assert_eq!(
            database
                .get_subscriptions("conn-tauri-fixture")
                .expect("subscriptions")
                .len(),
            1
        );
        assert_eq!(
            database
                .get_all_settings()
                .expect("settings")
                .get("theme")
                .map(String::as_str),
            Some("dark")
        );
        database
            .save_messages(&[message("after/clear", "works", "in")])
            .expect("save after clear");
        assert_eq!(
            database.get_storage_stats().expect("stats").message_count,
            1
        );
    }

    #[test]
    fn file_database_enables_wal_normal_sync_foreign_keys_checkpoint_and_vacuum() {
        let temporary = TempDatabase::new("pragmas");
        let database = Database::open(&temporary.path).expect("open database");
        {
            let connection = database.lock().expect("database lock");
            let journal: String = connection
                .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                .expect("journal");
            let synchronous: i64 = connection
                .query_row("PRAGMA synchronous", [], |row| row.get(0))
                .expect("synchronous");
            let foreign_keys: i64 = connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .expect("foreign keys");
            assert_eq!((journal.as_str(), synchronous, foreign_keys), ("wal", 1, 1));
        }
        database
            .save_connection(connection_input("conn-pragmas"))
            .expect("save connection");
        database
            .clear_history_storage()
            .expect("checkpoint and vacuum");
        let checkpoint: (i64, i64, i64) = database
            .lock()
            .expect("lock")
            .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .expect("checkpoint status");
        assert_eq!(checkpoint.0, 0);
    }

    #[test]
    fn received_history_uses_specific_subscription_and_commits_before_delivery() {
        let temporary = TempDatabase::new("native-received-history");
        let database = Database::open(&temporary.path).unwrap();
        database
            .save_connection(connection_input("native"))
            .unwrap();
        database
            .add_subscription(SubscriptionInput {
                id: "broad".into(),
                connection_id: "native".into(),
                topic: "sensors/#".into(),
                format: "text".into(),
                ..Default::default()
            })
            .unwrap();
        database
            .add_subscription(SubscriptionInput {
                id: "exact".into(),
                connection_id: "native".into(),
                topic: "sensors/raw".into(),
                format: "hex".into(),
                ..Default::default()
            })
            .unwrap();
        let events = (0..5000)
            .map(|_| crate::mqtt::MqttMessageEvent {
                conn_id: "native".into(),
                topic: "sensors/raw".into(),
                payload: "�".into(),
                payload_hex: "00ff".into(),
                qos: 1,
                retained: true,
                time: String::new(),
                byte_length: 2,
            })
            .collect::<Vec<_>>();
        database.save_received_messages(&events).unwrap();
        assert_eq!(database.get_message_counts().unwrap()[0].messages_in, 5000);
        let row = database
            .query_history_messages(&HistoryFilter {
                conn_id: "native".into(),
                ..Default::default()
            })
            .unwrap()
            .rows
            .remove(0);
        assert_eq!(row.payload, "00FF");
        assert_eq!(row.format, "hex");
        assert_eq!(row.qos, 1);
        assert_eq!(row.retained, 1);
    }

    #[test]
    fn native_json_history_preserves_received_key_order() {
        let temporary = TempDatabase::new("native-json-order");
        let database = Database::open(&temporary.path).unwrap();
        database
            .save_connection(connection_input("native"))
            .unwrap();
        database.save_setting("payloadFormat", "json").unwrap();
        let event = crate::mqtt::MqttMessageEvent {
            conn_id: "native".into(),
            topic: "test".into(),
            payload: r#"{"z":1,"a":2}"#.into(),
            payload_hex: "".into(),
            qos: 1,
            retained: false,
            time: String::new(),
            byte_length: 13,
        };
        database.save_received_messages(&[event]).unwrap();
        let row = database
            .query_history_messages(&HistoryFilter::default())
            .unwrap()
            .rows
            .remove(0);
        assert_eq!(row.payload, "{\n  \"z\": 1,\n  \"a\": 2\n}");
    }

    #[test]
    fn failed_received_history_keeps_update_checkpoint_blocked() {
        let temporary = TempDatabase::new("native-history-failure");
        let database = Database::open(&temporary.path).unwrap();
        let event = crate::mqtt::MqttMessageEvent {
            conn_id: "missing".into(),
            topic: "test".into(),
            payload: "unsaved".into(),
            payload_hex: "".into(),
            qos: 1,
            retained: false,
            time: String::new(),
            byte_length: 7,
        };
        assert!(database.save_received_messages(&[event]).is_err());
        assert!(database
            .checkpoint_for_update()
            .unwrap_err()
            .contains("history"));
    }

    #[test]
    fn update_checkpoint_blocks_on_reader_and_preserves_database_for_retry() {
        let temporary = TempDatabase::new("update-checkpoint");
        let database = Database::open(&temporary.path).unwrap();
        database
            .save_connection(connection_input("checkpoint"))
            .unwrap();
        database
            .lock()
            .unwrap()
            .busy_timeout(std::time::Duration::from_millis(1))
            .unwrap();
        let reader = Connection::open(&temporary.path).unwrap();
        reader
            .execute_batch("BEGIN; SELECT * FROM connections;")
            .unwrap();
        database
            .save_connection(connection_input("after-reader"))
            .unwrap();
        assert!(database
            .checkpoint_for_update()
            .unwrap_err()
            .contains("busy"));
        reader.execute_batch("ROLLBACK").unwrap();
        database.checkpoint_for_update().unwrap();
        database
            .save_connection(connection_input("after-checkpoint"))
            .unwrap();
        assert_eq!(database.get_connections().unwrap().len(), 3);
    }

    #[test]
    fn generates_uuid_ids_and_cloned_handles_are_thread_safe() {
        let temporary = TempDatabase::new("concurrency");
        let database = Database::open(&temporary.path).expect("open database");
        database
            .save_connection(connection_input(""))
            .expect("save generated connection");
        let generated = database
            .get_connections()
            .expect("connections")
            .into_iter()
            .find(|row| row.name == "Local broker")
            .expect("generated connection");
        assert!(uuid::Uuid::parse_str(
            generated
                .id
                .strip_prefix("conn-")
                .expect("connection prefix")
        )
        .is_ok());

        let mut subscription = SubscriptionInput {
            id: String::new(),
            connection_id: generated.id.clone(),
            topic: "generated/#".into(),
            qos: 0,
            status: String::new(),
            color: String::new(),
            format: String::new(),
        };
        let subscription_id = database
            .add_subscription(subscription.clone())
            .expect("generated subscription");
        assert!(uuid::Uuid::parse_str(
            subscription_id
                .strip_prefix("sub-")
                .expect("subscription prefix")
        )
        .is_ok());
        subscription.id = subscription_id;

        let clones = (0..4)
            .map(|index| {
                let database = database.clone();
                std::thread::spawn(move || database.save_setting(&format!("thread-{index}"), "ok"))
            })
            .collect::<Vec<_>>();
        for handle in clones {
            handle.join().expect("thread join").expect("thread write");
        }
        assert_eq!(database.get_all_settings().expect("settings").len(), 4);
    }
}
