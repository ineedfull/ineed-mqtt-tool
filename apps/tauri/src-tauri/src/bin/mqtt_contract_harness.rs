use ineed_mqtt_tool_lib::database::{ConnectionInput, Database, MessageInput};
use ineed_mqtt_tool_lib::mqtt::{
    MqttConnectionInput, MqttEventSink, MqttMessageEvent, MqttService, MqttStatusEvent,
    PublishPayload, SharedMqttEventSink,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env,
    io::{self, BufRead, BufReader, BufWriter, Write},
    path::Path,
    sync::{Arc, Mutex},
};

const MAX_INPUT_LINE_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_LINE_BYTES: usize = 12 * 1024 * 1024;

#[derive(Clone)]
struct NdjsonSink {
    writer: Arc<Mutex<BufWriter<io::Stdout>>>,
}

impl NdjsonSink {
    fn write(&self, value: &Value) -> Result<(), String> {
        let encoded = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        if encoded.len() > MAX_OUTPUT_LINE_BYTES {
            return Err(format!(
                "harness output exceeds {MAX_OUTPUT_LINE_BYTES} bytes"
            ));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "harness stdout mutex poisoned".to_string())?;
        writer
            .write_all(&encoded)
            .map_err(|error| error.to_string())?;
        writer.write_all(b"\n").map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    }
}

impl MqttEventSink for NdjsonSink {
    fn emit_status(&self, event: &MqttStatusEvent) -> Result<(), String> {
        self.write(&json!({ "kind": "event", "channel": "mqtt:status", "payload": event }))
    }

    fn emit_messages(&self, messages: &[MqttMessageEvent]) -> Result<(), String> {
        self.write(&json!({ "kind": "event", "channel": "mqtt:messages", "payload": messages }))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseInitArgs {
    database_path: String,
    connection_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseSaveMessagesArgs {
    rows: Vec<MessageInput>,
}

#[derive(Deserialize)]
struct DatabaseFailNextArgs {
    count: usize,
}

struct HarnessDatabase {
    database: Database,
    fail_next: usize,
}

fn dispatch_database(command: &str, args: Value, state: &mut Option<HarnessDatabase>) -> Value {
    match command {
        "db_init" => match parse_args::<DatabaseInitArgs>(args) {
            Ok(_) if state.is_some() => {
                json!({ "ok": false, "error": "database is already initialized" })
            }
            Ok(args) if !Path::new(&args.database_path).is_absolute() => {
                json!({ "ok": false, "error": "database path must be absolute" })
            }
            Ok(args) => match Database::open(&args.database_path) {
                Ok(database) => {
                    let saved = args.connection_ids.iter().try_for_each(|connection_id| {
                        database
                            .save_connection(ConnectionInput {
                                id: connection_id.clone(),
                                name: connection_id.clone(),
                                host: "127.0.0.1".into(),
                                ..ConnectionInput::default()
                            })
                            .map(|_| ())
                    });
                    match saved {
                        Ok(()) => {
                            *state = Some(HarnessDatabase {
                                database,
                                fail_next: 0,
                            });
                            json!({ "ok": true })
                        }
                        Err(error) => json!({ "ok": false, "error": error }),
                    }
                }
                Err(error) => json!({ "ok": false, "error": error }),
            },
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "db_save_messages" => {
            match (state.as_mut(), parse_args::<DatabaseSaveMessagesArgs>(args)) {
                (Some(database), Ok(_)) if database.fail_next > 0 => {
                    database.fail_next -= 1;
                    json!({ "ok": false, "error": "injected database failure before production save" })
                }
                (Some(database), Ok(args)) => match database.database.save_messages(&args.rows) {
                    Ok(()) => json!({ "ok": true }),
                    Err(error) => json!({ "ok": false, "error": error }),
                },
                (None, _) => json!({ "ok": false, "error": "database is not initialized" }),
                (_, Err(error)) => json!({ "ok": false, "error": error }),
            }
        }
        "db_fail_next" => match (state.as_mut(), parse_args::<DatabaseFailNextArgs>(args)) {
            (Some(database), Ok(args)) if args.count <= 100 => {
                database.fail_next = args.count;
                json!({ "ok": true })
            }
            (Some(_), Ok(_)) => json!({ "ok": false, "error": "fail-next count exceeds 100" }),
            (None, _) => json!({ "ok": false, "error": "database is not initialized" }),
            (_, Err(error)) => json!({ "ok": false, "error": error }),
        },
        "db_count" => match state.as_ref() {
            Some(database) => match database.database.get_storage_stats() {
                Ok(stats) => json!({
                    "ok": true,
                    "count": stats.message_count,
                    "databaseBytes": stats.total_bytes,
                }),
                Err(error) => json!({ "ok": false, "error": error }),
            },
            None => json!({ "ok": false, "error": "database is not initialized" }),
        },
        "db_close" => {
            let was_open = state.take().is_some();
            json!({ "ok": true, "wasOpen": was_open })
        }
        _ => json!({ "ok": false, "error": format!("unknown database command: {command}") }),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnIdArgs {
    conn_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectArgs {
    conn: MqttConnectionInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeArgs {
    conn_id: String,
    topic: String,
    qos: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnsubscribeArgs {
    conn_id: String,
    topic: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishArgs {
    conn_id: String,
    topic: String,
    payload: PublishPayload,
    qos: u8,
    retain: bool,
}

fn parse_args<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("invalid command args: {error}"))
}

fn read_bounded_line<R: BufRead>(reader: &mut R, line: &mut Vec<u8>) -> io::Result<bool> {
    line.clear();
    loop {
        let (consumed, found_newline, overflowed) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                return Ok(!line.is_empty());
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let consumed = newline.map_or(available.len(), |index| index + 1);
            let remaining = (MAX_INPUT_LINE_BYTES + 1).saturating_sub(line.len());
            let copied = consumed.min(remaining);
            line.extend_from_slice(&available[..copied]);
            (
                consumed,
                newline.is_some(),
                copied < consumed || line.len() > MAX_INPUT_LINE_BYTES,
            )
        };
        reader.consume(consumed);
        if overflowed {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("mqtt contract input exceeds {MAX_INPUT_LINE_BYTES} bytes"),
            ));
        }
        if found_newline {
            return Ok(true);
        }
    }
}

async fn dispatch(
    service: &MqttService,
    sink: &SharedMqttEventSink,
    connections: &mut HashSet<String>,
    request: Request,
) -> Value {
    let result = match request.command.as_str() {
        "connect" => match parse_args::<ConnectArgs>(request.args) {
            Ok(args) => {
                let conn_id = serde_json::to_value(&args.conn)
                    .ok()
                    .and_then(|value| value.get("id").and_then(Value::as_str).map(str::to_owned));
                let result = service.connect(sink.clone(), args.conn).await;
                if let Some(conn_id) = conn_id.filter(|_| {
                    serde_json::to_value(&result)
                        .ok()
                        .and_then(|value| value.get("ok").and_then(Value::as_bool))
                        .unwrap_or(false)
                }) {
                    connections.insert(conn_id);
                }
                serde_json::to_value(result)
                    .unwrap_or_else(|error| json!({ "ok": false, "error": error.to_string() }))
            }
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "disconnect" => match parse_args::<ConnIdArgs>(request.args) {
            Ok(args) => {
                let result = service.disconnect(sink, &args.conn_id).await;
                connections.remove(&args.conn_id);
                serde_json::to_value(result).unwrap()
            }
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "subscribe" => match parse_args::<SubscribeArgs>(request.args) {
            Ok(args) => serde_json::to_value(
                service
                    .subscribe(&args.conn_id, &args.topic, args.qos)
                    .await,
            )
            .unwrap(),
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "unsubscribe" => match parse_args::<UnsubscribeArgs>(request.args) {
            Ok(args) => {
                serde_json::to_value(service.unsubscribe(&args.conn_id, &args.topic).await).unwrap()
            }
            Err(error) => json!({ "ok": false, "error": error }),
        },
        "publish" => match parse_args::<PublishArgs>(request.args) {
            Ok(args) => serde_json::to_value(
                service
                    .publish(
                        &args.conn_id,
                        &args.topic,
                        args.payload,
                        args.qos,
                        args.retain,
                    )
                    .await,
            )
            .unwrap(),
            Err(error) => json!({ "ok": false, "error": error }),
        },
        _ => json!({ "ok": false, "error": format!("unknown command: {}", request.command) }),
    };
    json!({ "kind": "result", "id": request.id, "value": result })
}

fn main() {
    if env::args_os().len() != 1 {
        eprintln!("mqtt contract harness accepts no arguments");
        std::process::exit(2);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .expect("create MQTT contract runtime");
    let ndjson = NdjsonSink {
        writer: Arc::new(Mutex::new(BufWriter::new(io::stdout()))),
    };
    let sink: SharedMqttEventSink = Arc::new(ndjson.clone());
    let mut database: Option<HarnessDatabase> = None;
    let service = MqttService::default();
    let mut connections = HashSet::new();
    let mut reader = BufReader::new(io::stdin());
    let mut line = Vec::with_capacity(MAX_INPUT_LINE_BYTES + 1);

    loop {
        let has_line = match read_bounded_line(&mut reader, &mut line) {
            Ok(has_line) => has_line,
            Err(error) => {
                eprintln!("mqtt contract stdin read failed: {error}");
                std::process::exit(2);
            }
        };
        if !has_line {
            break;
        }
        let request = match serde_json::from_slice::<Request>(&line) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("invalid mqtt contract request: {error}");
                continue;
            }
        };
        let response = if request.command.starts_with("db_") {
            let id = request.id;
            let result = dispatch_database(&request.command, request.args, &mut database);
            json!({ "kind": "result", "id": id, "value": result })
        } else {
            runtime.block_on(dispatch(&service, &sink, &mut connections, request))
        };
        if let Err(error) = ndjson.write(&response) {
            eprintln!("mqtt contract stdout write failed: {error}");
            break;
        }
    }

    runtime.block_on(async {
        for conn_id in connections {
            let _ = service.disconnect(&sink, &conn_id).await;
        }
    });
    drop(database);
}

#[cfg(test)]
mod bounded_input_tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn oversized_input_without_newline_is_rejected_with_a_strict_buffer_cap() {
        let mut reader = BufReader::new(Cursor::new(vec![b'x'; MAX_INPUT_LINE_BYTES * 4]));
        let mut line = Vec::with_capacity(MAX_INPUT_LINE_BYTES + 1);
        let error = read_bounded_line(&mut reader, &mut line).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(line.len() <= MAX_INPUT_LINE_BYTES + 1);
        assert!(line.capacity() <= MAX_INPUT_LINE_BYTES + 1);
    }
}
