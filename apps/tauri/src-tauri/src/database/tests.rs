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
    let schema = format!("{schema}\nCREATE INDEX extra_message_topic ON message_history(topic);");
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
