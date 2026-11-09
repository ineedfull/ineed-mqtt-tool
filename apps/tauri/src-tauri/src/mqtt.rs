use chrono::{SecondsFormat, TimeZone, Utc};
use rumqttc::{
    valid_filter as is_valid_filter, valid_topic as is_valid_topic, AsyncClient, ConnectReturnCode,
    ConnectionError, Event, EventLoop, MqttOptions, Outgoing, Packet, QoS, SubscribeReasonCode,
    Transport,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    mem,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use tauri::{async_runtime::JoinHandle, AppHandle, Emitter, Manager, State};
use tokio::{
    sync::{oneshot, Mutex},
    time::{interval, sleep, timeout, MissedTickBehavior},
};
use url::Url;

const MAX_CONNECTION_ID_BYTES: usize = 256;
const MAX_HOST_BYTES: usize = 1_024;
const MAX_CLIENT_ID_BYTES: usize = 256;
const MAX_PATH_BYTES: usize = 2_048;
const MAX_TOPIC_BYTES: usize = 65_535;
const MAX_INBOUND_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_BATCH_PAYLOAD_BYTES: usize = MAX_INBOUND_PAYLOAD_BYTES + 64 * 1024;
const MAX_MESSAGE_BATCH_SIZE: usize = 200;
const MQTT_QUEUE_CAPACITY: usize = 200;
const ACK_TIMEOUT: Duration = Duration::from_secs(8);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const RECONNECT_DELAY: Duration = Duration::from_millis(1_000);

fn default_protocol() -> String {
    "mqtt".into()
}

fn default_keepalive() -> u64 {
    60
}

fn default_clean_session() -> bool {
    true
}

fn default_auto_reconnect() -> bool {
    true
}

fn deserialize_boolish<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Bool(value) => Ok(value),
        serde_json::Value::Number(value) if value.as_i64() == Some(0) => Ok(false),
        serde_json::Value::Number(value) if value.as_i64() == Some(1) => Ok(true),
        serde_json::Value::String(value) if value == "0" || value == "false" => Ok(false),
        serde_json::Value::String(value) if value == "1" || value == "true" => Ok(true),
        _ => Err(serde::de::Error::custom(
            "expected a boolean or 0/1 boolean value",
        )),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttConnectionInput {
    #[serde(default)]
    id: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: u16,
    #[serde(default = "default_protocol")]
    protocol: String,
    #[serde(default)]
    path: String,
    #[serde(default, alias = "client_id")]
    client_id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default = "default_keepalive")]
    keepalive: u64,
    #[serde(
        default = "default_clean_session",
        alias = "clean_session",
        deserialize_with = "deserialize_boolish"
    )]
    clean_session: bool,
    #[serde(
        default = "default_auto_reconnect",
        alias = "auto_reconnect",
        deserialize_with = "deserialize_boolish"
    )]
    auto_reconnect: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum PublishPayload {
    Text(String),
    Bytes(Vec<u8>),
}

impl PublishPayload {
    fn into_bytes(self) -> Vec<u8> {
        match self {
            Self::Text(value) => value.into_bytes(),
            Self::Bytes(value) => value,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MqttDiagnostic {
    source: String,
    code: String,
    reason: String,
}

impl MqttDiagnostic {
    fn new(source: impl Into<String>, code: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            code: code.into(),
            reason: reason.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttMessageEvent {
    pub conn_id: String,
    pub topic: String,
    pub payload: String,
    pub payload_hex: String,
    pub qos: u8,
    pub retained: bool,
    pub time: String,
    pub byte_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttStatusEvent {
    pub conn_id: String,
    pub status: String,
    pub error: Option<String>,
    diagnostic: Option<MqttDiagnostic>,
    pub source: String,
    pub code: String,
    pub reason: String,
    pub reconnected: bool,
    pub attempt: u32,
    pub next_delay_ms: Option<u64>,
    pub disconnected_at: Option<i64>,
}

impl MqttStatusEvent {
    fn new(
        conn_id: impl Into<String>,
        status: impl Into<String>,
        diagnostic: Option<MqttDiagnostic>,
        reconnected: bool,
        attempt: u32,
        next_delay_ms: Option<u64>,
        disconnected_at: Option<i64>,
    ) -> Self {
        let (error, source, code, reason) = diagnostic.as_ref().map_or_else(
            || (None, "unknown".into(), String::new(), String::new()),
            |value| {
                (
                    Some(value.reason.clone()),
                    value.source.clone(),
                    value.code.clone(),
                    value.reason.clone(),
                )
            },
        );
        Self {
            conn_id: conn_id.into(),
            status: status.into(),
            error,
            diagnostic,
            source,
            code,
            reason,
            reconnected,
            attempt,
            next_delay_ms,
            disconnected_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MqttCommandResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl MqttCommandResult {
    fn success() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
        }
    }
}

fn classify_mqtt_error(error: impl ToString) -> MqttDiagnostic {
    let reason = error.to_string();
    let text = reason.to_lowercase();
    let (source, code) = if text.contains("not authorized")
        || text.contains("bad user")
        || text.contains("authentication")
    {
        ("broker", "AUTH_FAILED")
    } else if text.contains("dns")
        || text.contains("lookup")
        || text.contains("resolve")
        || text.contains("no such host")
    {
        ("network", "DNS_FAILED")
    } else if text.contains("certificate") || text.contains("tls") || text.contains("ssl") {
        ("client", "TLS_FAILED")
    } else if text.contains("reset") || text.contains("socket hang up") {
        ("network", "CONNECTION_RESET")
    } else if text.contains("refused") {
        ("network", "CONNECTION_REFUSED")
    } else if text.contains("keepalive") || text.contains("ping") && text.contains("timeout") {
        ("network", "KEEPALIVE_TIMEOUT")
    } else if text.contains("timeout") || text.contains("timed out") {
        ("network", "CONNECTION_TIMEOUT")
    } else if text.contains("closed") || text.contains("eof") || text.contains("connection lost") {
        ("network", "SOCKET_CLOSED")
    } else if text.contains("invalid") || text.contains("unsupported") || text.contains("malformed")
    {
        ("client", "INVALID_CONFIG")
    } else {
        ("unknown", "UNKNOWN_DISCONNECT")
    };
    MqttDiagnostic::new(source, code, reason)
}

fn is_retryable_diagnostic(diagnostic: &MqttDiagnostic) -> bool {
    !matches!(diagnostic.source.as_str(), "broker" | "client")
}

struct ClassifiedConnectionError {
    diagnostic: MqttDiagnostic,
    retryable: bool,
}

fn classify_connection_error(error: &ConnectionError) -> ClassifiedConnectionError {
    let reason = error.to_string();
    let classified = match error {
        ConnectionError::ConnectionRefused(ConnectReturnCode::BadUserNamePassword)
        | ConnectionError::ConnectionRefused(ConnectReturnCode::NotAuthorized) => {
            return ClassifiedConnectionError {
                diagnostic: MqttDiagnostic::new("broker", "AUTH_FAILED", "authentication failed"),
                retryable: false,
            };
        }
        ConnectionError::ConnectionRefused(ConnectReturnCode::BadClientId) => {
            Some(("client", "BAD_CLIENT_ID", false))
        }
        ConnectionError::ConnectionRefused(ConnectReturnCode::RefusedProtocolVersion) => {
            Some(("client", "UNSUPPORTED_PROTOCOL_VERSION", false))
        }
        ConnectionError::ConnectionRefused(ConnectReturnCode::ServiceUnavailable) => {
            Some(("broker", "SERVICE_UNAVAILABLE", true))
        }
        ConnectionError::ConnectionRefused(ConnectReturnCode::Success) => {
            Some(("client", "UNEXPECTED_CONNACK", false))
        }
        _ => None,
    };
    if let Some((source, code, retryable)) = classified {
        return ClassifiedConnectionError {
            diagnostic: MqttDiagnostic::new(source, code, reason),
            retryable,
        };
    }

    let diagnostic = classify_mqtt_error(reason);
    let retryable = is_retryable_diagnostic(&diagnostic);
    ClassifiedConnectionError {
        diagnostic,
        retryable,
    }
}

fn validate_nonblank(value: &str, label: &str, max_bytes: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.len() > max_bytes {
        return Err(format!("{label} exceeds {max_bytes} bytes"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label} contains control characters"));
    }
    Ok(())
}

fn validate_connection(input: &MqttConnectionInput) -> Result<(), String> {
    validate_nonblank(&input.id, "connection id", MAX_CONNECTION_ID_BYTES)?;
    validate_nonblank(&input.host, "MQTT host", MAX_HOST_BYTES)?;
    let host = &input.host;
    if host.contains(':') || host.contains('[') || host.contains(']') {
        let literal = host
            .strip_prefix('[')
            .and_then(|v| v.strip_suffix(']'))
            .unwrap_or(host);
        if literal.parse::<std::net::Ipv6Addr>().is_err() {
            return Err("Invalid MQTT IPv6 host".into());
        }
    } else if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err("MQTT host contains invalid characters".into());
    }
    if input.port == 0 {
        return Err("MQTT port must be between 1 and 65535".into());
    }
    if input.path.len() > MAX_PATH_BYTES {
        return Err(format!("MQTT path exceeds {MAX_PATH_BYTES} bytes"));
    }
    if matches!(normalize_protocol(&input.protocol)?, "ws" | "wss")
        && input
            .path
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '#' | '\\' | '\u{feff}'))
    {
        return Err("Invalid MQTT WebSocket path".into());
    }
    if input.client_id.len() > MAX_CLIENT_ID_BYTES {
        return Err(format!(
            "MQTT client id exceeds {MAX_CLIENT_ID_BYTES} bytes"
        ));
    }
    if input.keepalive == 0 || input.keepalive > u64::from(u16::MAX) {
        return Err("MQTT keepalive must be between 1 and 65535 seconds".into());
    }
    normalize_protocol(&input.protocol)?;
    Ok(())
}

fn validate_conn_id(conn_id: &str) -> Result<(), String> {
    validate_nonblank(conn_id, "connection id", MAX_CONNECTION_ID_BYTES)
}

fn validate_topic(topic: &str, allow_wildcards: bool) -> Result<(), String> {
    validate_nonblank(topic, "topic", MAX_TOPIC_BYTES)?;
    let valid = if allow_wildcards {
        is_valid_filter(topic)
    } else {
        is_valid_topic(topic)
    };
    if !valid {
        return Err(if allow_wildcards {
            "invalid MQTT topic filter".into()
        } else {
            "invalid MQTT publish topic".into()
        });
    }
    Ok(())
}

fn normalize_protocol(protocol: &str) -> Result<&'static str, String> {
    match protocol {
        "mqtt" | "mqtt://" => Ok("mqtt"),
        "mqtts" | "mqtts://" => Ok("mqtts"),
        "ws" | "ws://" => Ok("ws"),
        "wss" | "wss://" => Ok("wss"),
        _ => Err(format!("unsupported MQTT protocol: {protocol}")),
    }
}

fn encoded_host(host: &str) -> String {
    if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn build_broker_url(input: &MqttConnectionInput) -> Result<String, String> {
    validate_connection(input)?;
    let protocol = normalize_protocol(&input.protocol)?;
    let path = if matches!(protocol, "ws" | "wss") {
        if input.path.is_empty() {
            "/mqtt".to_string()
        } else if input.path.starts_with('/') {
            input.path.clone()
        } else {
            format!("/{}", input.path)
        }
    } else {
        String::new()
    };
    let endpoint = format!(
        "{protocol}://{}:{}{path}",
        encoded_host(&input.host),
        input.port
    );
    Url::parse(&endpoint).map_err(|error| error.to_string())?;
    Ok(endpoint)
}

fn build_mqtt_options(input: &MqttConnectionInput) -> Result<MqttOptions, String> {
    let broker_url = build_broker_url(input)?;
    let protocol = normalize_protocol(&input.protocol)?;
    let client_id = if input.client_id.is_empty() {
        format!("ineed-{}", uuid::Uuid::new_v4())
    } else {
        input.client_id.clone()
    };
    let broker_address = if matches!(protocol, "ws" | "wss") {
        broker_url
    } else {
        // TCP sockets need the IP literal without URL authority brackets.
        input
            .host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string()
    };
    let mut options = MqttOptions::new(client_id, broker_address, input.port);
    match protocol {
        "mqtt" => {}
        "mqtts" => {
            options.set_transport(Transport::tls_with_default_config());
        }
        "ws" => {
            options.set_transport(Transport::ws());
        }
        "wss" => {
            options.set_transport(Transport::wss_with_default_config());
        }
        _ => unreachable!("normalized MQTT protocol"),
    }
    options
        .set_keep_alive(Duration::from_secs(input.keepalive))
        .set_clean_session(input.clean_session)
        .set_max_packet_size(10 * 1024 * 1024, 10 * 1024 * 1024);
    if !input.username.is_empty() {
        options.set_credentials(input.username.clone(), input.password.clone());
    }
    Ok(options)
}

fn qos_from_u8(qos: u8) -> Result<QoS, String> {
    match qos {
        0 => Ok(QoS::AtMostOnce),
        1 => Ok(QoS::AtLeastOnce),
        2 => Ok(QoS::ExactlyOnce),
        _ => Err("QoS must be 0, 1, or 2".into()),
    }
}

fn qos_to_u8(qos: QoS) -> u8 {
    match qos {
        QoS::AtMostOnce => 0,
        QoS::AtLeastOnce => 1,
        QoS::ExactlyOnce => 2,
    }
}

fn message_event(
    conn_id: &str,
    topic: &str,
    payload: Vec<u8>,
    qos: QoS,
    retained: bool,
    timestamp_ms: i64,
) -> MqttMessageEvent {
    let time = Utc
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    MqttMessageEvent {
        conn_id: conn_id.into(),
        topic: topic.into(),
        payload: String::from_utf8_lossy(&payload).into_owned(),
        payload_hex: payload.iter().map(|byte| format!("{byte:02x}")).collect(),
        qos: qos_to_u8(qos),
        retained,
        time,
        byte_length: payload.len(),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum BatchPush {
    Queued,
    Flush(Vec<MqttMessageEvent>),
    FlushAndQueue(Vec<MqttMessageEvent>),
    DroppedTooLarge,
}

#[derive(Default)]
struct MessageBatch {
    items: Vec<MqttMessageEvent>,
    payload_bytes: usize,
}

impl MessageBatch {
    fn push(&mut self, event: MqttMessageEvent, payload_bytes: usize) -> BatchPush {
        if payload_bytes > MAX_INBOUND_PAYLOAD_BYTES {
            return BatchPush::DroppedTooLarge;
        }
        if !self.items.is_empty()
            && self.payload_bytes.saturating_add(payload_bytes) > MAX_BATCH_PAYLOAD_BYTES
        {
            let flushed = mem::take(&mut self.items);
            self.payload_bytes = payload_bytes;
            self.items.push(event);
            return BatchPush::FlushAndQueue(flushed);
        }
        self.payload_bytes = self.payload_bytes.saturating_add(payload_bytes);
        self.items.push(event);
        if self.items.len() >= MAX_MESSAGE_BATCH_SIZE {
            self.payload_bytes = 0;
            BatchPush::Flush(mem::take(&mut self.items))
        } else {
            BatchPush::Queued
        }
    }

    fn take(&mut self) -> Option<Vec<MqttMessageEvent>> {
        if self.items.is_empty() {
            None
        } else {
            self.payload_bytes = 0;
            Some(mem::take(&mut self.items))
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.items.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LifecycleChange {
    Connected { reconnected: bool },
    Reconnecting { attempt: u32, next_delay_ms: u64 },
    Terminated,
    Ignored,
}

#[derive(Default)]
struct RuntimeLifecycle {
    connected_once: bool,
    outage: bool,
    terminal: bool,
    attempt: u32,
}

impl RuntimeLifecycle {
    fn on_connack(&mut self) -> LifecycleChange {
        if self.terminal {
            return LifecycleChange::Ignored;
        }
        let reconnected = self.connected_once && self.outage;
        self.connected_once = true;
        self.outage = false;
        self.attempt = 0;
        LifecycleChange::Connected { reconnected }
    }

    fn on_poll_error(&mut self, auto_reconnect: bool, retryable: bool) -> LifecycleChange {
        if self.terminal {
            return LifecycleChange::Ignored;
        }
        if !auto_reconnect || !retryable {
            self.terminal = true;
            return LifecycleChange::Terminated;
        }
        self.outage = true;
        self.attempt = self.attempt.saturating_add(1);
        LifecycleChange::Reconnecting {
            attempt: self.attempt,
            next_delay_ms: RECONNECT_DELAY.as_millis() as u64,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum OperationKind {
    Publish,
    Subscribe,
    Unsubscribe,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct OperationKey {
    conn_id: String,
    generation: u64,
    kind: OperationKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingSlot {
    Live(u64),
    Expired(u64),
}

impl PendingSlot {
    fn live_id(self) -> Option<u64> {
        match self {
            Self::Live(id) => Some(id),
            Self::Expired(_) => None,
        }
    }
}

#[derive(Default)]
struct PendingOperations {
    next_id: u64,
    unassigned: HashMap<OperationKey, VecDeque<PendingSlot>>,
    assigned: HashMap<(OperationKey, u16), PendingSlot>,
}

impl PendingOperations {
    fn enqueue(&mut self, conn_id: &str, generation: u64, kind: OperationKind) -> u64 {
        self.next_id = self.next_id.saturating_add(1);
        self.unassigned
            .entry(OperationKey {
                conn_id: conn_id.into(),
                generation,
                kind,
            })
            .or_default()
            .push_back(PendingSlot::Live(self.next_id));
        self.next_id
    }

    fn assign(
        &mut self,
        conn_id: &str,
        generation: u64,
        kind: OperationKind,
        packet_id: u16,
    ) -> Option<u64> {
        let key = OperationKey {
            conn_id: conn_id.into(),
            generation,
            kind,
        };
        let assignment = (key.clone(), packet_id);
        if self.assigned.contains_key(&assignment) {
            return None;
        }
        let slot = self.unassigned.get_mut(&key)?.pop_front()?;
        if self.unassigned.get(&key).is_some_and(VecDeque::is_empty) {
            self.unassigned.remove(&key);
        }
        self.assigned.insert(assignment, slot);
        slot.live_id()
    }

    fn complete(
        &mut self,
        conn_id: &str,
        generation: u64,
        kind: OperationKind,
        packet_id: u16,
    ) -> Option<u64> {
        self.assigned
            .remove(&(
                OperationKey {
                    conn_id: conn_id.into(),
                    generation,
                    kind,
                },
                packet_id,
            ))
            .and_then(PendingSlot::live_id)
    }

    fn remove_id(&mut self, id: u64) {
        self.unassigned.retain(|_, queue| {
            queue
                .retain(|slot| !matches!(slot, PendingSlot::Live(pending_id) if *pending_id == id));
            !queue.is_empty()
        });
        self.assigned
            .retain(|_, slot| !matches!(slot, PendingSlot::Live(pending_id) if *pending_id == id));
    }

    fn expire_id(&mut self, id: u64) {
        for queue in self.unassigned.values_mut() {
            if let Some(slot) = queue
                .iter_mut()
                .find(|slot| matches!(slot, PendingSlot::Live(pending_id) if *pending_id == id))
            {
                *slot = PendingSlot::Expired(id);
                return;
            }
        }
        if let Some(slot) = self
            .assigned
            .values_mut()
            .find(|slot| matches!(slot, PendingSlot::Live(pending_id) if *pending_id == id))
        {
            *slot = PendingSlot::Expired(id);
        }
    }

    fn expire_connection_for_retry(&mut self, conn_id: &str, generation: u64) -> Vec<u64> {
        let mut ids = Vec::new();
        for (key, queue) in &mut self.unassigned {
            if key.conn_id != conn_id || key.generation != generation {
                continue;
            }
            for slot in queue {
                if let PendingSlot::Live(id) = slot {
                    ids.push(*id);
                    *slot = PendingSlot::Expired(*id);
                }
            }
        }

        self.assigned.retain(|(key, _), slot| {
            if key.conn_id != conn_id || key.generation != generation {
                return true;
            }
            if let PendingSlot::Live(id) = slot {
                ids.push(*id);
                if key.kind == OperationKind::Publish {
                    *slot = PendingSlot::Expired(*id);
                    return true;
                }
            }
            key.kind == OperationKind::Publish
        });
        ids.sort_unstable();
        ids
    }

    fn clear_connection(&mut self, conn_id: &str, generation: u64) -> Vec<u64> {
        let keys = self
            .unassigned
            .keys()
            .filter(|key| key.conn_id == conn_id && key.generation == generation)
            .cloned()
            .collect::<Vec<_>>();
        let mut ids = Vec::new();
        for key in keys {
            if let Some(queue) = self.unassigned.remove(&key) {
                ids.extend(queue.into_iter().filter_map(|slot| match slot {
                    PendingSlot::Live(id) => Some(id),
                    PendingSlot::Expired(_) => None,
                }));
            }
        }
        let assigned = self
            .assigned
            .keys()
            .filter(|(key, _)| key.conn_id == conn_id && key.generation == generation)
            .cloned()
            .collect::<Vec<_>>();
        for key in assigned {
            if let Some(slot) = self.assigned.remove(&key) {
                ids.extend(slot.live_id());
            }
        }
        ids
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.unassigned.is_empty() && self.assigned.is_empty()
    }
}

#[derive(Default)]
struct PendingState {
    operations: PendingOperations,
    senders: HashMap<u64, oneshot::Sender<Result<(), String>>>,
}

type SharedPending = Arc<Mutex<PendingState>>;

async fn enqueue_pending(
    pending: &SharedPending,
    conn_id: &str,
    generation: u64,
    kind: OperationKind,
) -> (u64, oneshot::Receiver<Result<(), String>>) {
    let (sender, receiver) = oneshot::channel();
    let mut state = pending.lock().await;
    let id = state.operations.enqueue(conn_id, generation, kind);
    state.senders.insert(id, sender);
    (id, receiver)
}

async fn assign_pending(
    pending: &SharedPending,
    conn_id: &str,
    generation: u64,
    kind: OperationKind,
    packet_id: u16,
) -> bool {
    pending
        .lock()
        .await
        .operations
        .assign(conn_id, generation, kind, packet_id)
        .is_some()
}

async fn complete_pending(
    pending: &SharedPending,
    conn_id: &str,
    generation: u64,
    kind: OperationKind,
    packet_id: u16,
    result: Result<(), String>,
) {
    let sender = {
        let mut state = pending.lock().await;
        let id = state
            .operations
            .complete(conn_id, generation, kind, packet_id);
        id.and_then(|id| state.senders.remove(&id))
    };
    if let Some(sender) = sender {
        let _ = sender.send(result);
    }
}

async fn cancel_pending_request(pending: &SharedPending, id: u64) {
    let mut state = pending.lock().await;
    state.operations.remove_id(id);
    state.senders.remove(&id);
}

async fn expire_pending_request(pending: &SharedPending, id: u64) {
    let mut state = pending.lock().await;
    state.operations.expire_id(id);
    state.senders.remove(&id);
}

fn remove_pending_senders(
    state: &mut PendingState,
    ids: Vec<u64>,
) -> Vec<oneshot::Sender<Result<(), String>>> {
    ids.into_iter()
        .filter_map(|id| state.senders.remove(&id))
        .collect()
}

async fn fail_pending_for_retry(
    pending: &SharedPending,
    conn_id: &str,
    generation: u64,
    error: &str,
) {
    let senders = {
        let mut state = pending.lock().await;
        let ids = state
            .operations
            .expire_connection_for_retry(conn_id, generation);
        remove_pending_senders(&mut state, ids)
    };
    for sender in senders {
        let _ = sender.send(Err(error.into()));
    }
}

async fn clear_pending(pending: &SharedPending, conn_id: &str, generation: u64, error: &str) {
    let senders = {
        let mut state = pending.lock().await;
        let ids = state.operations.clear_connection(conn_id, generation);
        remove_pending_senders(&mut state, ids)
    };
    for sender in senders {
        let _ = sender.send(Err(error.into()));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GuardPhase {
    Active,
    Stopping,
    Inactive,
}

struct GuardState {
    phase: GuardPhase,
    terminal_claimed: bool,
}

type SharedIdentities = Arc<StdMutex<HashMap<String, u64>>>;

fn new_identity_registry() -> SharedIdentities {
    Arc::new(StdMutex::new(HashMap::new()))
}

fn set_current_identity(identities: &SharedIdentities, conn_id: &str, generation: u64) {
    identities
        .lock()
        .expect("MQTT identity registry poisoned")
        .insert(conn_id.into(), generation);
}

fn remove_identity_if_current(identities: &SharedIdentities, conn_id: &str, generation: u64) {
    let mut state = identities.lock().expect("MQTT identity registry poisoned");
    if state.get(conn_id) == Some(&generation) {
        state.remove(conn_id);
    }
}

#[derive(Clone)]
struct IdentityGuard {
    state: Arc<StdMutex<GuardState>>,
    identity: Option<(SharedIdentities, String, u64)>,
}

impl IdentityGuard {
    fn active() -> Self {
        Self {
            state: Arc::new(StdMutex::new(GuardState {
                phase: GuardPhase::Active,
                terminal_claimed: false,
            })),
            identity: None,
        }
    }

    #[cfg(test)]
    fn active_for(identities: SharedIdentities, conn_id: &str, generation: u64) -> Self {
        set_current_identity(&identities, conn_id, generation);
        Self::for_current(identities, conn_id, generation)
    }

    fn for_current(identities: SharedIdentities, conn_id: &str, generation: u64) -> Self {
        Self {
            state: Arc::new(StdMutex::new(GuardState {
                phase: GuardPhase::Active,
                terminal_claimed: false,
            })),
            identity: Some((identities, conn_id.into(), generation)),
        }
    }

    fn with_current_state<T>(
        &self,
        operation: impl FnOnce(&mut GuardState) -> Option<T>,
    ) -> Option<T> {
        let _identities = match &self.identity {
            Some((identities, conn_id, generation)) => {
                let state = identities.lock().expect("MQTT identity registry poisoned");
                if state.get(conn_id) != Some(generation) {
                    return None;
                }
                Some(state)
            }
            None => None,
        };
        let mut state = self.state.lock().expect("MQTT identity guard poisoned");
        operation(&mut state)
    }

    fn begin_stop(&self) -> bool {
        self.with_current_state(|state| {
            if state.phase != GuardPhase::Active {
                return None;
            }
            state.phase = GuardPhase::Stopping;
            Some(())
        })
        .is_some()
    }

    fn deactivate(&self) {
        self.state
            .lock()
            .expect("MQTT identity guard poisoned")
            .phase = GuardPhase::Inactive;
    }

    fn allows_status(&self) -> bool {
        self.with_current_state(|state| (state.phase == GuardPhase::Active).then_some(()))
            .is_some()
    }

    #[cfg(test)]
    fn allows_batch(&self) -> bool {
        self.with_current_state(|state| (state.phase != GuardPhase::Inactive).then_some(()))
            .is_some()
    }

    fn run_if_active<T>(&self, action: impl FnOnce() -> T) -> Option<T> {
        self.with_current_state(|state| (state.phase == GuardPhase::Active).then(action))
    }

    fn run_if_batch_allowed<T>(&self, action: impl FnOnce() -> T) -> Option<T> {
        self.with_current_state(|state| (state.phase != GuardPhase::Inactive).then(action))
    }

    #[cfg(test)]
    fn claim_terminal(&self) -> bool {
        self.with_current_state(|state| {
            if state.phase != GuardPhase::Stopping || state.terminal_claimed {
                return None;
            }
            state.terminal_claimed = true;
            Some(())
        })
        .is_some()
    }

    fn run_terminal<T>(&self, action: impl FnOnce() -> T) -> Option<T> {
        self.with_current_state(|state| {
            if state.phase != GuardPhase::Stopping || state.terminal_claimed {
                return None;
            }
            state.terminal_claimed = true;
            Some(action())
        })
    }
}

#[derive(Clone, Default)]
struct StopReason(Arc<StdMutex<Option<String>>>);

impl StopReason {
    fn set(&self, reason: &str) {
        let mut state = self.0.lock().expect("MQTT stop reason poisoned");
        if state.is_none() {
            *state = Some(reason.into());
        }
    }

    fn message(&self, fallback: &str) -> String {
        self.0
            .lock()
            .expect("MQTT stop reason poisoned")
            .clone()
            .unwrap_or_else(|| fallback.into())
    }
}

struct ClientHandle {
    client: AsyncClient,
    task: JoinHandle<()>,
    generation: u64,
    guard: IdentityGuard,
    stop_reason: StopReason,
}

enum ClientSlot {
    Starting { generation: u64 },
    Running(ClientHandle),
}

impl ClientSlot {
    fn generation(&self) -> u64 {
        match self {
            Self::Starting { generation } => *generation,
            Self::Running(handle) => handle.generation,
        }
    }
}

type SharedClients = Arc<Mutex<HashMap<String, ClientSlot>>>;

pub trait MqttEventSink: Send + Sync {
    fn emit_status(&self, event: &MqttStatusEvent) -> Result<(), String>;
    fn emit_messages(&self, messages: &[MqttMessageEvent]) -> Result<(), String>;
}

pub type SharedMqttEventSink = Arc<dyn MqttEventSink>;

struct AppHandleEventSink(AppHandle);

impl MqttEventSink for AppHandleEventSink {
    fn emit_status(&self, event: &MqttStatusEvent) -> Result<(), String> {
        self.0
            .emit("mqtt:status", event)
            .map_err(|error| error.to_string())
    }

    fn emit_messages(&self, messages: &[MqttMessageEvent]) -> Result<(), String> {
        self.0
            .state::<crate::database::Database>()
            .save_received_messages(messages)?;
        #[derive(Serialize)]
        struct CommittedMessage<'a> {
            #[serde(flatten)]
            message: &'a MqttMessageEvent,
            #[serde(rename = "historyPersisted")]
            history_persisted: bool,
        }
        let committed: Vec<_> = messages
            .iter()
            .map(|message| CommittedMessage {
                message,
                history_persisted: true,
            })
            .collect();
        self.0
            .emit("mqtt:messages", &committed)
            .map_err(|error| error.to_string())
    }
}

fn emit_status(
    sink: &SharedMqttEventSink,
    guard: &IdentityGuard,
    event: MqttStatusEvent,
) -> Result<(), String> {
    let Some(result) = guard.run_if_active(|| sink.emit_status(&event)) else {
        return Ok(());
    };
    result.inspect_err(|error| eprintln!("MQTT status emit failed: {error}"))
}

fn emit_messages(
    sink: &SharedMqttEventSink,
    guard: &IdentityGuard,
    conn_id: &str,
    messages: Vec<MqttMessageEvent>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    let message_count = messages.len();
    let Some(result) = guard.run_if_batch_allowed(|| sink.emit_messages(&messages)) else {
        eprintln!(
            "Dropped {} stale MQTT messages for superseded connection {conn_id}",
            message_count
        );
        return Ok(());
    };
    result.inspect_err(|error| eprintln!("MQTT message emit failed for {conn_id}: {error}"))
}

#[derive(Default)]
struct StatusTiming {
    attempt: u32,
    next_delay_ms: Option<u64>,
    disconnected_at: Option<i64>,
}

fn emit_diagnostic(
    sink: &SharedMqttEventSink,
    guard: &IdentityGuard,
    conn_id: &str,
    status: &str,
    diagnostic: MqttDiagnostic,
    timing: StatusTiming,
) -> Result<(), String> {
    emit_status(
        sink,
        guard,
        MqttStatusEvent::new(
            conn_id,
            status,
            Some(diagnostic),
            false,
            timing.attempt,
            timing.next_delay_ms,
            timing.disconnected_at,
        ),
    )
}

fn emit_terminal_status(
    sink: &SharedMqttEventSink,
    guard: &IdentityGuard,
    event: MqttStatusEvent,
) -> Result<(), String> {
    let Some(result) = guard.run_terminal(|| sink.emit_status(&event)) else {
        return Ok(());
    };
    result.map_err(|error| {
        let message = format!("MQTT terminal status emit failed: {error}");
        eprintln!("{message}");
        message
    })
}

fn emit_terminal_diagnostic(
    sink: &SharedMqttEventSink,
    guard: &IdentityGuard,
    conn_id: &str,
    status: &str,
    diagnostic: MqttDiagnostic,
    timing: StatusTiming,
) {
    let _ = emit_terminal_status(
        sink,
        guard,
        MqttStatusEvent::new(
            conn_id,
            status,
            Some(diagnostic),
            false,
            timing.attempt,
            timing.next_delay_ms,
            timing.disconnected_at,
        ),
    );
}

fn emit_disconnected(sink: &SharedMqttEventSink, guard: &IdentityGuard, conn_id: &str) {
    let _ = emit_terminal_status(
        sink,
        guard,
        MqttStatusEvent::new(
            conn_id,
            "disconnected",
            Some(MqttDiagnostic::new(
                "user",
                "USER_DISCONNECTED",
                "connection closed by user",
            )),
            false,
            0,
            None,
            None,
        ),
    );
}

async fn remove_client_if_current(clients: &SharedClients, conn_id: &str, generation: u64) {
    let mut state = clients.lock().await;
    if state
        .get(conn_id)
        .is_some_and(|slot| slot.generation() == generation)
    {
        state.remove(conn_id);
    }
}

struct EventLoopContext {
    sink: SharedMqttEventSink,
    clients: SharedClients,
    identities: SharedIdentities,
    pending: SharedPending,
    conn_id: String,
    generation: u64,
    guard: IdentityGuard,
    stop_reason: StopReason,
    auto_reconnect: bool,
}

async fn run_event_loop(
    context: EventLoopContext,
    mut event_loop: EventLoop,
    connect_sender: oneshot::Sender<Result<(), String>>,
) {
    let EventLoopContext {
        sink,
        clients,
        identities,
        pending,
        conn_id,
        generation,
        guard,
        stop_reason,
        auto_reconnect,
    } = context;
    let mut connect_sender = Some(connect_sender);
    let mut lifecycle = RuntimeLifecycle::default();
    let mut disconnected_at = None;
    let mut batch = MessageBatch::default();
    let mut flush_interval = interval(Duration::from_millis(200));
    flush_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    flush_interval.tick().await;

    'poll: loop {
        let event = tokio::select! {
            event = event_loop.poll() => Some(event),
            _ = flush_interval.tick() => {
                if let Some(messages) = batch.take() {
                    if let Err(error) = emit_messages(&sink, &guard, &conn_id, messages) {
                        stop_reason.set(&error);
                        guard.begin_stop();
                        if let Some(sender) = connect_sender.take() {
                            let _ = sender.send(Err(error));
                        }
                        break 'poll;
                    }
                }
                None
            }
        };
        let Some(event) = event else {
            continue;
        };
        match event {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                let completed_attempt = lifecycle.attempt;
                if let LifecycleChange::Connected { reconnected } = lifecycle.on_connack() {
                    let result = emit_status(
                        &sink,
                        &guard,
                        MqttStatusEvent::new(
                            &conn_id,
                            "connected",
                            None,
                            reconnected,
                            completed_attempt,
                            None,
                            disconnected_at,
                        ),
                    );
                    if let Err(error) = result {
                        stop_reason.set(&error);
                        guard.begin_stop();
                        if let Some(sender) = connect_sender.take() {
                            let _ = sender.send(Err(error));
                        }
                        break;
                    }
                    disconnected_at = None;
                    if let Some(sender) = connect_sender.take() {
                        let _ = sender.send(Ok(()));
                    }
                }
            }
            Ok(Event::Incoming(Packet::Publish(publish))) => {
                let payload = publish.payload.to_vec();
                let payload_bytes = payload.len();
                if payload_bytes > MAX_INBOUND_PAYLOAD_BYTES {
                    if let Err(error) = emit_diagnostic(
                        &sink,
                        &guard,
                        &conn_id,
                        "error",
                        MqttDiagnostic::new(
                            "client",
                            "PAYLOAD_TOO_LARGE",
                            format!(
                                "Inbound MQTT payload exceeds {MAX_INBOUND_PAYLOAD_BYTES} bytes"
                            ),
                        ),
                        StatusTiming {
                            attempt: lifecycle.attempt,
                            disconnected_at,
                            ..StatusTiming::default()
                        },
                    ) {
                        stop_reason.set(&error);
                        guard.begin_stop();
                        break;
                    }
                    continue;
                }
                let event = message_event(
                    &conn_id,
                    &publish.topic,
                    payload,
                    publish.qos,
                    publish.retain,
                    Utc::now().timestamp_millis(),
                );
                match batch.push(event, payload_bytes) {
                    BatchPush::Queued => {}
                    BatchPush::Flush(messages) => {
                        if let Err(error) = emit_messages(&sink, &guard, &conn_id, messages) {
                            stop_reason.set(&error);
                            guard.begin_stop();
                            break;
                        }
                    }
                    BatchPush::FlushAndQueue(messages) => {
                        if let Err(error) = emit_messages(&sink, &guard, &conn_id, messages) {
                            stop_reason.set(&error);
                            guard.begin_stop();
                            break;
                        }
                    }
                    BatchPush::DroppedTooLarge => {
                        if let Err(error) = emit_diagnostic(
                            &sink,
                            &guard,
                            &conn_id,
                            "error",
                            MqttDiagnostic::new(
                                "client",
                                "PAYLOAD_TOO_LARGE",
                                format!(
                                    "Inbound MQTT payload exceeds {MAX_INBOUND_PAYLOAD_BYTES} bytes"
                                ),
                            ),
                            StatusTiming {
                                attempt: lifecycle.attempt,
                                disconnected_at,
                                ..StatusTiming::default()
                            },
                        ) {
                            stop_reason.set(&error);
                            guard.begin_stop();
                            break;
                        }
                    }
                }
            }
            Ok(Event::Outgoing(Outgoing::Publish(packet_id))) if packet_id != 0 => {
                let _ = assign_pending(
                    &pending,
                    &conn_id,
                    generation,
                    OperationKind::Publish,
                    packet_id,
                )
                .await;
            }
            Ok(Event::Incoming(Packet::PubAck(pub_ack))) => {
                complete_pending(
                    &pending,
                    &conn_id,
                    generation,
                    OperationKind::Publish,
                    pub_ack.pkid,
                    Ok(()),
                )
                .await;
            }
            Ok(Event::Incoming(Packet::PubComp(pub_comp))) => {
                complete_pending(
                    &pending,
                    &conn_id,
                    generation,
                    OperationKind::Publish,
                    pub_comp.pkid,
                    Ok(()),
                )
                .await;
            }
            Ok(Event::Outgoing(Outgoing::Subscribe(packet_id))) => {
                if !assign_pending(
                    &pending,
                    &conn_id,
                    generation,
                    OperationKind::Subscribe,
                    packet_id,
                )
                .await
                {
                    eprintln!(
                        "MQTT subscribe packet {packet_id} has no pending command for {conn_id}"
                    );
                }
            }
            Ok(Event::Incoming(Packet::SubAck(sub_ack))) => {
                let accepted = sub_ack
                    .return_codes
                    .iter()
                    .all(|code| matches!(code, SubscribeReasonCode::Success(_)));
                let result = if accepted {
                    Ok(())
                } else {
                    Err("broker rejected subscription".into())
                };
                complete_pending(
                    &pending,
                    &conn_id,
                    generation,
                    OperationKind::Subscribe,
                    sub_ack.pkid,
                    result,
                )
                .await;
            }
            Ok(Event::Outgoing(Outgoing::Unsubscribe(packet_id))) => {
                if !assign_pending(
                    &pending,
                    &conn_id,
                    generation,
                    OperationKind::Unsubscribe,
                    packet_id,
                )
                .await
                {
                    eprintln!(
                        "MQTT unsubscribe packet {packet_id} has no pending command for {conn_id}"
                    );
                }
            }
            Ok(Event::Incoming(Packet::UnsubAck(unsub_ack))) => {
                complete_pending(
                    &pending,
                    &conn_id,
                    generation,
                    OperationKind::Unsubscribe,
                    unsub_ack.pkid,
                    Ok(()),
                )
                .await;
            }
            Ok(Event::Outgoing(Outgoing::Disconnect)) => break,
            Ok(_) => {}
            Err(error) => {
                let message = error.to_string();
                let classified = classify_connection_error(&error);
                if let Some(messages) = batch.take() {
                    if let Err(error) = emit_messages(&sink, &guard, &conn_id, messages) {
                        stop_reason.set(&error);
                        guard.begin_stop();
                        if let Some(sender) = connect_sender.take() {
                            let _ = sender.send(Err(error));
                        }
                        break;
                    }
                }
                let initial_connection = connect_sender.is_some();
                match lifecycle.on_poll_error(auto_reconnect, classified.retryable) {
                    LifecycleChange::Reconnecting {
                        attempt,
                        next_delay_ms,
                    } => {
                        fail_pending_for_retry(&pending, &conn_id, generation, &message).await;
                        let outage_started =
                            *disconnected_at.get_or_insert_with(|| Utc::now().timestamp_millis());
                        if let Err(error) = emit_diagnostic(
                            &sink,
                            &guard,
                            &conn_id,
                            "reconnecting",
                            MqttDiagnostic::new("network", "SOCKET_CLOSED", "connection closed"),
                            StatusTiming {
                                attempt,
                                next_delay_ms: Some(next_delay_ms),
                                disconnected_at: Some(outage_started),
                            },
                        ) {
                            stop_reason.set(&error);
                            guard.begin_stop();
                            if let Some(sender) = connect_sender.take() {
                                let _ = sender.send(Err(error));
                            }
                            break;
                        }
                        sleep(RECONNECT_DELAY).await;
                    }
                    LifecycleChange::Terminated => {
                        clear_pending(&pending, &conn_id, generation, &message).await;
                        guard.begin_stop();
                        emit_terminal_diagnostic(
                            &sink,
                            &guard,
                            &conn_id,
                            if initial_connection {
                                "error"
                            } else {
                                "offline"
                            },
                            classified.diagnostic,
                            StatusTiming {
                                attempt: lifecycle.attempt,
                                disconnected_at,
                                ..StatusTiming::default()
                            },
                        );
                        if let Some(sender) = connect_sender.take() {
                            let _ = sender.send(Err(message));
                        }
                        break;
                    }
                    LifecycleChange::Connected { .. } | LifecycleChange::Ignored => {
                        clear_pending(&pending, &conn_id, generation, &message).await;
                        break;
                    }
                }
            }
        }
    }

    if let Some(messages) = batch.take() {
        let _ = emit_messages(&sink, &guard, &conn_id, messages);
    }
    clear_pending(&pending, &conn_id, generation, "connection closed").await;
    if let Some(sender) = connect_sender.take() {
        let _ = sender.send(Err(stop_reason.message("MQTT connection task stopped")));
    }
    remove_client_if_current(&clients, &conn_id, generation).await;
    remove_identity_if_current(&identities, &conn_id, generation);
    guard.deactivate();
}

async fn stop_handle(
    conn_id: &str,
    mut handle: ClientHandle,
    pending: &SharedPending,
    identities: &SharedIdentities,
    reason: &str,
) {
    handle.guard.begin_stop();
    handle.stop_reason.set(reason);
    clear_pending(pending, conn_id, handle.generation, reason).await;
    match timeout(SHUTDOWN_TIMEOUT, handle.client.disconnect()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("MQTT disconnect queue failed for {conn_id}: {error}"),
        Err(_) => eprintln!(
            "MQTT disconnect queue exceeded {} ms for {conn_id}",
            SHUTDOWN_TIMEOUT.as_millis()
        ),
    }
    if timeout(SHUTDOWN_TIMEOUT, &mut handle.task).await.is_err() {
        eprintln!(
            "MQTT event loop shutdown exceeded {} ms for {conn_id}; pending batch may be dropped",
            SHUTDOWN_TIMEOUT.as_millis()
        );
        handle.task.abort();
        let _ = handle.task.await;
    }
    handle.guard.deactivate();
    remove_identity_if_current(identities, conn_id, handle.generation);
}

pub struct MqttService {
    clients: SharedClients,
    identities: SharedIdentities,
    pending: SharedPending,
    generation: AtomicU64,
}

impl Default for MqttService {
    fn default() -> Self {
        Self {
            clients: Arc::new(Mutex::new(HashMap::new())),
            identities: new_identity_registry(),
            pending: Arc::new(Mutex::new(PendingState::default())),
            generation: AtomicU64::new(1),
        }
    }
}

impl MqttService {
    async fn reserve_generation(
        &self,
        conn_id: &str,
        generation: u64,
    ) -> (Option<ClientHandle>, IdentityGuard) {
        let mut clients = self.clients.lock().await;
        set_current_identity(&self.identities, conn_id, generation);
        let guard = IdentityGuard::for_current(self.identities.clone(), conn_id, generation);
        let previous = clients.insert(conn_id.into(), ClientSlot::Starting { generation });
        let handle = match previous {
            Some(ClientSlot::Running(handle)) => Some(handle),
            Some(ClientSlot::Starting { .. }) | None => None,
        };
        (handle, guard)
    }

    async fn is_starting_generation(&self, conn_id: &str, generation: u64) -> bool {
        matches!(
            self.clients.lock().await.get(conn_id),
            Some(ClientSlot::Starting { generation: current }) if *current == generation
        )
    }

    async fn is_running_generation(&self, conn_id: &str, generation: u64) -> bool {
        matches!(
            self.clients.lock().await.get(conn_id),
            Some(ClientSlot::Running(handle)) if handle.generation == generation
        )
    }

    async fn take_generation(&self, conn_id: &str, generation: u64) -> Option<ClientHandle> {
        let mut state = self.clients.lock().await;
        if state
            .get(conn_id)
            .is_none_or(|slot| slot.generation() != generation)
        {
            return None;
        }
        match state.remove(conn_id) {
            Some(ClientSlot::Running(handle)) => {
                handle.guard.begin_stop();
                Some(handle)
            }
            Some(ClientSlot::Starting { .. }) | None => None,
        }
    }

    async fn running_client(&self, conn_id: &str) -> Option<(AsyncClient, u64)> {
        match self.clients.lock().await.get(conn_id) {
            Some(ClientSlot::Running(handle)) if handle.guard.allows_status() => {
                Some((handle.client.clone(), handle.generation))
            }
            Some(ClientSlot::Running(_)) | Some(ClientSlot::Starting { .. }) | None => None,
        }
    }

    pub async fn connect(
        &self,
        sink: SharedMqttEventSink,
        input: MqttConnectionInput,
    ) -> MqttCommandResult {
        let options = match build_mqtt_options(&input) {
            Ok(options) => options,
            Err(error) => {
                if !input.id.trim().is_empty() {
                    let guard = IdentityGuard::active();
                    let _ = emit_diagnostic(
                        &sink,
                        &guard,
                        &input.id,
                        "error",
                        classify_mqtt_error(&error),
                        StatusTiming::default(),
                    );
                }
                return MqttCommandResult::failure(error);
            }
        };
        let conn_id = input.id.clone();
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let (previous, guard) = self.reserve_generation(&conn_id, generation).await;
        if let Some(previous) = previous {
            stop_handle(
                &conn_id,
                previous,
                &self.pending,
                &self.identities,
                "connection replaced",
            )
            .await;
        }
        if !self.is_starting_generation(&conn_id, generation).await {
            return MqttCommandResult::failure("connection replaced");
        }

        let (client, event_loop) = AsyncClient::new(options, MQTT_QUEUE_CAPACITY);
        let (connect_sender, connect_receiver) = oneshot::channel();
        let (start_sender, start_receiver) = oneshot::channel();
        let task_guard = guard.clone();
        let task_clients = self.clients.clone();
        let task_identities = self.identities.clone();
        let task_pending = self.pending.clone();
        let task_sink = sink.clone();
        let task_conn_id = conn_id.clone();
        let auto_reconnect = input.auto_reconnect;
        let stop_reason = StopReason::default();
        let task_stop_reason = stop_reason.clone();
        let task = tauri::async_runtime::spawn(async move {
            if start_receiver.await.is_err() {
                return;
            }
            run_event_loop(
                EventLoopContext {
                    sink: task_sink,
                    clients: task_clients,
                    identities: task_identities,
                    pending: task_pending,
                    conn_id: task_conn_id,
                    generation,
                    guard: task_guard,
                    stop_reason: task_stop_reason,
                    auto_reconnect,
                },
                event_loop,
                connect_sender,
            )
            .await;
        });
        let handle = ClientHandle {
            client,
            task,
            generation,
            guard: guard.clone(),
            stop_reason,
        };
        let rejected = {
            let mut state = self.clients.lock().await;
            if matches!(
                state.get(&conn_id),
                Some(ClientSlot::Starting { generation: current }) if *current == generation
            ) {
                state.insert(conn_id.clone(), ClientSlot::Running(handle));
                None
            } else {
                Some(handle)
            }
        };
        if let Some(handle) = rejected {
            drop(start_sender);
            handle.task.abort();
            let _ = handle.task.await;
            return MqttCommandResult::failure("connection replaced");
        }

        if let Err(error) = emit_status(
            &sink,
            &guard,
            MqttStatusEvent::new(
                &conn_id,
                "connecting",
                Some(MqttDiagnostic::new("client", "CONNECTING", "")),
                false,
                0,
                None,
                None,
            ),
        ) {
            drop(start_sender);
            if let Some(handle) = self.take_generation(&conn_id, generation).await {
                stop_handle(&conn_id, handle, &self.pending, &self.identities, &error).await;
            }
            return MqttCommandResult::failure(error);
        }
        if start_sender.send(()).is_err() {
            if let Some(handle) = self.take_generation(&conn_id, generation).await {
                stop_handle(
                    &conn_id,
                    handle,
                    &self.pending,
                    &self.identities,
                    "connection task stopped",
                )
                .await;
            }
            return MqttCommandResult::failure("MQTT connection task stopped");
        }

        match timeout(CONNECT_TIMEOUT, connect_receiver).await {
            Ok(Ok(Ok(()))) if self.is_running_generation(&conn_id, generation).await => {
                MqttCommandResult::success()
            }
            Ok(Ok(Ok(()))) => MqttCommandResult::failure("connection replaced"),
            Ok(Ok(Err(error))) => {
                if let Some(handle) = self.take_generation(&conn_id, generation).await {
                    stop_handle(&conn_id, handle, &self.pending, &self.identities, &error).await;
                }
                MqttCommandResult::failure(error)
            }
            Ok(Err(_)) => {
                let error = if self.is_running_generation(&conn_id, generation).await {
                    "MQTT connection task stopped"
                } else {
                    "connection replaced"
                };
                if let Some(handle) = self.take_generation(&conn_id, generation).await {
                    stop_handle(&conn_id, handle, &self.pending, &self.identities, error).await;
                }
                MqttCommandResult::failure(error)
            }
            Err(_) => {
                if let Some(handle) = self.take_generation(&conn_id, generation).await {
                    emit_terminal_diagnostic(
                        &sink,
                        &handle.guard,
                        &conn_id,
                        "error",
                        classify_mqtt_error("MQTT connection timeout"),
                        StatusTiming::default(),
                    );
                    stop_handle(
                        &conn_id,
                        handle,
                        &self.pending,
                        &self.identities,
                        "MQTT connection timeout",
                    )
                    .await;
                }
                MqttCommandResult::failure("MQTT connection timeout")
            }
        }
    }

    pub async fn disconnect(&self, sink: &SharedMqttEventSink, conn_id: &str) -> MqttCommandResult {
        if let Err(error) = validate_conn_id(conn_id) {
            return MqttCommandResult::failure(error);
        }
        let slot = {
            let mut state = self.clients.lock().await;
            let guard = match state.get(conn_id) {
                Some(ClientSlot::Running(handle)) => Some(handle.guard.clone()),
                Some(ClientSlot::Starting { generation }) => Some(IdentityGuard::for_current(
                    self.identities.clone(),
                    conn_id,
                    *generation,
                )),
                None => None,
            };
            if let Some(guard) = guard {
                guard.begin_stop();
                emit_disconnected(sink, &guard, conn_id);
            }
            state.remove(conn_id)
        };
        match slot {
            Some(ClientSlot::Running(handle)) => {
                stop_handle(
                    conn_id,
                    handle,
                    &self.pending,
                    &self.identities,
                    "connection closed",
                )
                .await;
            }
            Some(ClientSlot::Starting { generation }) => {
                remove_identity_if_current(&self.identities, conn_id, generation);
            }
            None => {}
        }
        MqttCommandResult::success()
    }

    pub async fn subscribe(&self, conn_id: &str, topic: &str, qos: u8) -> MqttCommandResult {
        self.subscription_operation(conn_id, topic, Some(qos), OperationKind::Subscribe)
            .await
    }

    pub async fn unsubscribe(&self, conn_id: &str, topic: &str) -> MqttCommandResult {
        self.subscription_operation(conn_id, topic, None, OperationKind::Unsubscribe)
            .await
    }

    async fn subscription_operation(
        &self,
        conn_id: &str,
        topic: &str,
        qos: Option<u8>,
        kind: OperationKind,
    ) -> MqttCommandResult {
        if let Err(error) = validate_conn_id(conn_id) {
            return MqttCommandResult::failure(error);
        }
        if let Err(error) = validate_topic(topic, true) {
            return MqttCommandResult::failure(error);
        }
        let normalized_qos = match qos.map(qos_from_u8).transpose() {
            Ok(value) => value,
            Err(error) => return MqttCommandResult::failure(error),
        };
        let Some((client, generation)) = self.running_client(conn_id).await else {
            return MqttCommandResult::failure("not connected");
        };
        let (pending_id, receiver) =
            enqueue_pending(&self.pending, conn_id, generation, kind).await;
        let queued = match (kind, normalized_qos) {
            (OperationKind::Subscribe, Some(qos)) => client.subscribe(topic, qos).await,
            (OperationKind::Unsubscribe, None) => client.unsubscribe(topic).await,
            _ => unreachable!("validated subscription operation"),
        };
        if let Err(error) = queued {
            cancel_pending_request(&self.pending, pending_id).await;
            return MqttCommandResult::failure(error.to_string());
        }
        let timeout_error = match kind {
            OperationKind::Publish => unreachable!("publish uses its own operation path"),
            OperationKind::Subscribe => "subscribe timeout",
            OperationKind::Unsubscribe => "unsubscribe timeout",
        };
        match timeout(ACK_TIMEOUT, receiver).await {
            Ok(Ok(Ok(()))) if self.is_running_generation(conn_id, generation).await => {
                MqttCommandResult::success()
            }
            Ok(Ok(Ok(()))) => MqttCommandResult::failure("connection replaced"),
            Ok(Ok(Err(error))) => MqttCommandResult::failure(error),
            Ok(Err(_)) => MqttCommandResult::failure("acknowledgement tracking stopped"),
            Err(_) => {
                expire_pending_request(&self.pending, pending_id).await;
                MqttCommandResult::failure(timeout_error)
            }
        }
    }

    pub async fn publish(
        &self,
        conn_id: &str,
        topic: &str,
        payload: PublishPayload,
        qos: u8,
        retain: bool,
    ) -> MqttCommandResult {
        if let Err(error) = validate_conn_id(conn_id) {
            return MqttCommandResult::failure(error);
        }
        if let Err(error) = validate_topic(topic, false) {
            return MqttCommandResult::failure(error);
        }
        let qos = match qos_from_u8(qos) {
            Ok(qos) => qos,
            Err(error) => return MqttCommandResult::failure(error),
        };
        let Some((client, generation)) = self.running_client(conn_id).await else {
            return MqttCommandResult::failure("not connected");
        };
        let payload = payload.into_bytes();
        if payload.len() > MAX_INBOUND_PAYLOAD_BYTES {
            return MqttCommandResult::failure(format!(
                "MQTT payload exceeds {MAX_INBOUND_PAYLOAD_BYTES} bytes"
            ));
        }
        if qos == QoS::AtMostOnce {
            return match client.publish(topic, qos, retain, payload).await {
                Ok(()) if self.is_running_generation(conn_id, generation).await => {
                    MqttCommandResult::success()
                }
                Ok(()) => MqttCommandResult::failure("connection replaced"),
                Err(error) => MqttCommandResult::failure(error.to_string()),
            };
        }

        let (pending_id, receiver) =
            enqueue_pending(&self.pending, conn_id, generation, OperationKind::Publish).await;
        if let Err(error) = client.publish(topic, qos, retain, payload).await {
            cancel_pending_request(&self.pending, pending_id).await;
            return MqttCommandResult::failure(error.to_string());
        }
        match timeout(ACK_TIMEOUT, receiver).await {
            Ok(Ok(Ok(()))) if self.is_running_generation(conn_id, generation).await => {
                MqttCommandResult::success()
            }
            Ok(Ok(Ok(()))) => MqttCommandResult::failure("connection replaced"),
            Ok(Ok(Err(error))) => MqttCommandResult::failure(error),
            Ok(Err(_)) => MqttCommandResult::failure("acknowledgement tracking stopped"),
            Err(_) => {
                expire_pending_request(&self.pending, pending_id).await;
                MqttCommandResult::failure("publish timeout")
            }
        }
    }
}

#[tauri::command]
pub async fn mqtt_connect(
    app: AppHandle,
    service: State<'_, MqttService>,
    conn: MqttConnectionInput,
) -> Result<MqttCommandResult, String> {
    let sink: SharedMqttEventSink = Arc::new(AppHandleEventSink(app));
    Ok(service.connect(sink, conn).await)
}

#[tauri::command]
pub async fn mqtt_disconnect(
    app: AppHandle,
    service: State<'_, MqttService>,
    conn_id: String,
) -> Result<MqttCommandResult, String> {
    let sink: SharedMqttEventSink = Arc::new(AppHandleEventSink(app));
    Ok(service.disconnect(&sink, &conn_id).await)
}

#[tauri::command]
pub async fn mqtt_subscribe(
    service: State<'_, MqttService>,
    conn_id: String,
    topic: String,
    qos: u8,
) -> Result<MqttCommandResult, String> {
    Ok(service.subscribe(&conn_id, &topic, qos).await)
}

#[tauri::command]
pub async fn mqtt_unsubscribe(
    service: State<'_, MqttService>,
    conn_id: String,
    topic: String,
) -> Result<MqttCommandResult, String> {
    Ok(service.unsubscribe(&conn_id, &topic).await)
}

#[tauri::command]
pub async fn mqtt_publish(
    service: State<'_, MqttService>,
    conn_id: String,
    topic: String,
    payload: PublishPayload,
    qos: u8,
    retain: bool,
) -> Result<MqttCommandResult, String> {
    Ok(service
        .publish(&conn_id, &topic, payload, qos, retain)
        .await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};

    #[derive(Clone)]
    struct ControlledSink {
        status_calls: Arc<std::sync::atomic::AtomicUsize>,
        fail_status_at: Option<usize>,
        fail_messages: bool,
    }

    impl ControlledSink {
        fn new(fail_status_at: Option<usize>, fail_messages: bool) -> Self {
            Self {
                status_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                fail_status_at,
                fail_messages,
            }
        }
    }

    impl MqttEventSink for ControlledSink {
        fn emit_status(&self, _event: &MqttStatusEvent) -> Result<(), String> {
            let call = self
                .status_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail_status_at == Some(call) {
                Err("injected status sink failure".into())
            } else {
                Ok(())
            }
        }

        fn emit_messages(&self, _messages: &[MqttMessageEvent]) -> Result<(), String> {
            if self.fail_messages {
                Err("injected message sink failure".into())
            } else {
                Ok(())
            }
        }
    }

    fn read_mqtt_packet(stream: &mut std::net::TcpStream) -> Vec<u8> {
        let mut packet = Vec::new();
        let mut byte = [0_u8; 1];
        stream.read_exact(&mut byte).unwrap();
        packet.push(byte[0]);

        let mut remaining_len = 0_usize;
        let mut multiplier = 1_usize;
        loop {
            stream.read_exact(&mut byte).unwrap();
            packet.push(byte[0]);
            remaining_len += usize::from(byte[0] & 0x7f) * multiplier;
            if byte[0] & 0x80 == 0 {
                break;
            }
            multiplier *= 128;
        }

        let header_len = packet.len();
        packet.resize(header_len + remaining_len, 0);
        stream.read_exact(&mut packet[header_len..]).unwrap();
        packet
    }

    fn mqtt_payload_offset(packet: &[u8]) -> usize {
        let mut offset = 1;
        while packet[offset] & 0x80 != 0 {
            offset += 1;
        }
        offset + 1
    }

    fn subscription_topic(packet: &[u8]) -> &str {
        let payload = mqtt_payload_offset(packet);
        let topic_len = u16::from_be_bytes([packet[payload + 2], packet[payload + 3]]) as usize;
        std::str::from_utf8(&packet[payload + 4..payload + 4 + topic_len]).unwrap()
    }

    fn publish_packet_id(packet: &[u8]) -> u16 {
        let payload = mqtt_payload_offset(packet);
        let topic_len = u16::from_be_bytes([packet[payload], packet[payload + 1]]) as usize;
        let packet_id = payload + 2 + topic_len;
        u16::from_be_bytes([packet[packet_id], packet[packet_id + 1]])
    }

    fn connection(protocol: &str, path: &str) -> MqttConnectionInput {
        serde_json::from_value(json!({
            "id": "conn-1",
            "host": "broker.example.com",
            "port": 8084,
            "protocol": protocol,
            "path": path,
            "clientId": "client one",
            "username": "operator",
            "password": "secret",
            "keepalive": 45,
            "cleanSession": false,
            "autoReconnect": true
        }))
        .expect("valid connection fixture")
    }

    fn local_connection(port: u16) -> MqttConnectionInput {
        serde_json::from_value(json!({
            "id": "conn-1", "host": "127.0.0.1", "port": port,
            "protocol": "mqtt", "clientId": "sink-test", "keepalive": 5,
            "cleanSession": true, "autoReconnect": false
        }))
        .unwrap()
    }

    fn event(payload: Vec<u8>) -> MqttMessageEvent {
        message_event("conn-1", "devices/a", payload, QoS::AtLeastOnce, true, 42)
    }

    #[test]
    fn qos_accepts_only_protocol_levels() {
        assert_eq!(qos_from_u8(0), Ok(QoS::AtMostOnce));
        assert_eq!(qos_from_u8(1), Ok(QoS::AtLeastOnce));
        assert_eq!(qos_from_u8(2), Ok(QoS::ExactlyOnce));
        assert_eq!(qos_from_u8(3), Err("QoS must be 0, 1, or 2".into()));
        assert_eq!(qos_to_u8(QoS::ExactlyOnce), 2);
    }

    #[test]
    fn topics_enforce_mqtt_name_and_filter_grammar() {
        assert!(validate_topic("devices/+/status", true).is_ok());
        assert!(validate_topic("devices/#", true).is_ok());
        assert!(validate_topic("devices/#/status", true).is_err());
        assert!(validate_topic("devices+", true).is_err());
        assert!(validate_topic("devices/+/status", false).is_err());
        assert!(validate_topic("devices/status", false).is_ok());
    }

    #[test]
    fn broker_addresses_support_bare_and_bracketed_ipv6_and_validate_paths() {
        for host in ["::1", "[::1]"] {
            let mut input = connection("mqtt", "");
            input.host = host.into();
            assert_eq!(build_broker_url(&input).unwrap(), "mqtt://[::1]:8084");
            assert_eq!(
                build_mqtt_options(&input).unwrap().broker_address(),
                ("::1".into(), 8084)
            );
            input.protocol = "ws".into();
            assert_eq!(build_broker_url(&input).unwrap(), "ws://[::1]:8084/mqtt");
        }
        for host in [
            ":::1",
            "[::1",
            "::1]",
            "[broker]",
            "host:1883",
            "host\\path",
            " host ",
        ] {
            let mut input = connection("mqtt", "");
            input.host = host.into();
            assert!(build_broker_url(&input).is_err(), "{host}");
        }
        for path in ["/mqtt#fragment", "/mqtt\n", "/mqtt path", "/mqtt\\path"] {
            assert!(build_broker_url(&connection("ws", path)).is_err(), "{path}");
        }
        assert_eq!(
            build_broker_url(&connection("ws", "/")).unwrap(),
            "ws://broker.example.com:8084/"
        );
    }

    #[test]
    fn broker_urls_preserve_websocket_endpoint_without_mixing_client_options() {
        assert_eq!(
            build_broker_url(&connection("wss", "/tenant/mqtt?x=1")).unwrap(),
            "wss://broker.example.com:8084/tenant/mqtt?x=1"
        );
        assert_eq!(
            build_broker_url(&connection("ws", "")).unwrap(),
            "ws://broker.example.com:8084/mqtt"
        );
        let ws = build_mqtt_options(&connection("ws", "/tenant/mqtt?x=1")).unwrap();
        assert_eq!(
            ws.broker_address(),
            ("ws://broker.example.com:8084/tenant/mqtt?x=1".into(), 8084)
        );
        assert_eq!(ws.client_id(), "client one");
        assert!(matches!(ws.transport(), rumqttc::Transport::Ws));

        let wss = build_mqtt_options(&connection("wss", "/tenant/mqtt?x=1")).unwrap();
        assert_eq!(
            wss.broker_address(),
            ("wss://broker.example.com:8084/tenant/mqtt?x=1".into(), 8084)
        );
        assert!(matches!(wss.transport(), rumqttc::Transport::Wss(_)));
        assert!(matches!(
            build_mqtt_options(&connection("mqtts", ""))
                .unwrap()
                .transport(),
            rumqttc::Transport::Tls(_)
        ));
        assert!(build_broker_url(&connection("http", "")).is_err());
    }

    #[test]
    fn websocket_event_loop_parses_the_full_endpoint_before_network_failure() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            drop(stream);
        });

        let mut input = connection("ws", "/mqtt?tenant=local");
        input.host = "127.0.0.1".into();
        input.port = port;
        let options = build_mqtt_options(&input).unwrap();
        assert_eq!(
            options.broker_address(),
            (format!("ws://127.0.0.1:{port}/mqtt?tenant=local"), port)
        );

        tauri::async_runtime::block_on(async {
            let (_, mut event_loop) = AsyncClient::new(options, 4);
            let error = timeout(Duration::from_secs(3), event_loop.poll())
                .await
                .expect("local websocket poll must settle")
                .expect_err("local peer closes before websocket handshake");
            assert!(
                !matches!(error, rumqttc::ConnectionError::InvalidUrl(_)),
                "full websocket endpoint must parse before network failure: {error}"
            );
        });
        server.join().unwrap();
    }

    #[test]
    fn mqtt_options_use_persisted_session_credentials_and_client_id() {
        let options = build_mqtt_options(&connection("wss", "/mqtt")).unwrap();
        assert_eq!(options.client_id(), "client one");
        assert_eq!(options.keep_alive(), std::time::Duration::from_secs(45));
        assert!(!options.clean_session());
        assert!(matches!(options.transport(), rumqttc::Transport::Wss(_)));
    }

    #[test]
    fn keepalive_accepts_u16_max_and_rejects_larger_values() {
        let mut input = connection("mqtt", "");
        input.keepalive = u16::MAX.into();
        assert!(build_mqtt_options(&input).is_ok());

        input.keepalive = u64::from(u16::MAX) + 1;
        assert_eq!(
            build_mqtt_options(&input).unwrap_err(),
            "MQTT keepalive must be between 1 and 65535 seconds"
        );
    }

    #[test]
    fn payload_deserialization_preserves_utf8_and_all_byte_values() {
        let text: PublishPayload = serde_json::from_value(json!("中\0A")).unwrap();
        let bytes: PublishPayload = serde_json::from_value(json!([0, 255, 1])).unwrap();
        assert_eq!(text.into_bytes(), "中\0A".as_bytes());
        assert_eq!(bytes.into_bytes(), vec![0, 255, 1]);
        assert!(serde_json::from_value::<PublishPayload>(json!({ "0": 1 })).is_err());
        assert!(serde_json::from_value::<PublishPayload>(json!([256])).is_err());
    }

    #[test]
    fn status_and_message_events_serialize_exact_camel_case_payloads() {
        let diagnostic = MqttDiagnostic::new("network", "DNS_FAILED", "lookup failed");
        let status = MqttStatusEvent::new(
            "conn-1",
            "reconnecting",
            Some(diagnostic.clone()),
            false,
            2,
            Some(1_000),
            Some(42),
        );
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({
                "connId": "conn-1",
                "status": "reconnecting",
                "error": "lookup failed",
                "diagnostic": {
                    "source": "network",
                    "code": "DNS_FAILED",
                    "reason": "lookup failed"
                },
                "source": "network",
                "code": "DNS_FAILED",
                "reason": "lookup failed",
                "reconnected": false,
                "attempt": 2,
                "nextDelayMs": 1000,
                "disconnectedAt": 42
            })
        );
        assert_eq!(
            serde_json::to_value(event(vec![0, 255])).unwrap(),
            json!({
                "connId": "conn-1",
                "topic": "devices/a",
                "payload": "\u{0}\u{fffd}",
                "payloadHex": "00ff",
                "qos": 1,
                "retained": true,
                "time": "1970-01-01T00:00:00.042Z",
                "byteLength": 2
            })
        );
    }

    #[test]
    fn lifecycle_marks_reconnections_and_terminal_storms_once() {
        let mut lifecycle = RuntimeLifecycle::default();
        assert_eq!(
            lifecycle.on_connack(),
            LifecycleChange::Connected { reconnected: false }
        );
        assert_eq!(
            lifecycle.on_poll_error(true, true),
            LifecycleChange::Reconnecting {
                attempt: 1,
                next_delay_ms: 1_000
            }
        );
        assert_eq!(
            lifecycle.on_connack(),
            LifecycleChange::Connected { reconnected: true }
        );
        assert_eq!(
            lifecycle.on_poll_error(false, true),
            LifecycleChange::Terminated
        );
        assert_eq!(
            lifecycle.on_poll_error(true, true),
            LifecycleChange::Ignored
        );
    }

    #[test]
    fn lifecycle_retries_initial_network_errors_but_stops_terminal_errors() {
        assert!(is_retryable_diagnostic(&classify_mqtt_error(
            "connection refused"
        )));
        assert!(is_retryable_diagnostic(&classify_mqtt_error(
            "unknown transport failure"
        )));
        assert!(!is_retryable_diagnostic(&classify_mqtt_error(
            "not authorized"
        )));
        assert!(!is_retryable_diagnostic(&classify_mqtt_error(
            "invalid protocol configuration"
        )));

        let mut retrying = RuntimeLifecycle::default();
        assert_eq!(
            retrying.on_poll_error(true, true),
            LifecycleChange::Reconnecting {
                attempt: 1,
                next_delay_ms: 1_000,
            }
        );
        assert_eq!(
            retrying.on_connack(),
            LifecycleChange::Connected { reconnected: false }
        );

        let mut disabled = RuntimeLifecycle::default();
        assert_eq!(
            disabled.on_poll_error(false, true),
            LifecycleChange::Terminated
        );
        assert_eq!(
            disabled.on_poll_error(false, true),
            LifecycleChange::Ignored
        );

        let mut terminal = RuntimeLifecycle::default();
        assert_eq!(
            terminal.on_poll_error(true, false),
            LifecycleChange::Terminated
        );
        assert_eq!(terminal.on_connack(), LifecycleChange::Ignored);
    }

    #[test]
    fn connack_refusals_use_typed_permanent_and_transient_classification() {
        use rumqttc::{ConnectReturnCode, ConnectionError};

        let cases = [
            (
                ConnectReturnCode::BadUserNamePassword,
                "broker",
                "AUTH_FAILED",
                false,
            ),
            (
                ConnectReturnCode::NotAuthorized,
                "broker",
                "AUTH_FAILED",
                false,
            ),
            (
                ConnectReturnCode::BadClientId,
                "client",
                "BAD_CLIENT_ID",
                false,
            ),
            (
                ConnectReturnCode::RefusedProtocolVersion,
                "client",
                "UNSUPPORTED_PROTOCOL_VERSION",
                false,
            ),
            (
                ConnectReturnCode::ServiceUnavailable,
                "broker",
                "SERVICE_UNAVAILABLE",
                true,
            ),
        ];
        for (return_code, source, code, retryable) in cases {
            let classified =
                classify_connection_error(&ConnectionError::ConnectionRefused(return_code));
            assert_eq!(classified.diagnostic.source, source);
            assert_eq!(classified.diagnostic.code, code);
            assert_eq!(classified.retryable, retryable);
        }

        let network = classify_connection_error(&ConnectionError::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "reset by peer",
        )));
        assert_eq!(network.diagnostic.source, "network");
        assert!(network.retryable);
    }

    #[test]
    fn generation_guards_reject_late_events_and_cleanup() {
        let identities = new_identity_registry();
        set_current_identity(&identities, "conn-1", 1);
        let first = IdentityGuard::for_current(identities.clone(), "conn-1", 1);
        assert!(first.allows_status());

        set_current_identity(&identities, "conn-1", 2);
        let second = IdentityGuard::for_current(identities.clone(), "conn-1", 2);
        assert!(!first.allows_status());
        assert!(second.allows_status());

        remove_identity_if_current(&identities, "conn-1", 1);
        assert!(second.allows_status());
        remove_identity_if_current(&identities, "conn-1", 2);
        assert!(!second.allows_status());
    }

    #[test]
    fn identity_guard_allows_shutdown_flush_until_a_new_generation_replaces_it() {
        let identities = new_identity_registry();
        let first = IdentityGuard::active_for(identities.clone(), "conn-1", 1);
        first.begin_stop();
        assert!(first.allows_batch());

        let second = IdentityGuard::active_for(identities, "conn-1", 2);
        assert!(!first.allows_batch());
        assert!(!first.allows_status());
        assert!(second.allows_batch());
        assert!(second.allows_status());
    }

    #[test]
    fn terminal_generation_gate_has_one_concurrent_winner_and_rejects_stale_identity() {
        let identities = new_identity_registry();
        let current = IdentityGuard::active_for(identities.clone(), "conn-1", 1);
        assert!(current.begin_stop());
        assert!(!current.begin_stop());
        assert!(!current.allows_status());

        let winners = std::thread::scope(|scope| {
            let handles = (0..8)
                .map(|_| {
                    let guard = current.clone();
                    scope.spawn(move || guard.claim_terminal())
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|won| *won)
                .count()
        });
        assert_eq!(winners, 1);

        let stale = IdentityGuard::active_for(identities.clone(), "conn-1", 2);
        set_current_identity(&identities, "conn-1", 3);
        stale.begin_stop();
        assert!(!stale.claim_terminal());
    }

    #[test]
    fn stop_reason_preserves_the_replacement_result_for_an_initial_connect() {
        let reason = StopReason::default();
        assert_eq!(reason.message("task stopped"), "task stopped");
        reason.set("connection replaced");
        reason.set("connection closed");
        assert_eq!(reason.message("task stopped"), "connection replaced");
    }

    #[test]
    fn batch_flushes_at_200_and_drops_oversized_before_queueing() {
        let mut batch = MessageBatch::default();
        for index in 0..199 {
            assert_eq!(batch.push(event(vec![index as u8]), 1), BatchPush::Queued);
        }
        let flushed = batch.push(event(vec![199]), 1);
        assert!(matches!(flushed, BatchPush::Flush(items) if items.len() == 200));
        assert!(batch.take().is_none());

        assert_eq!(
            batch.push(event(Vec::new()), MAX_INBOUND_PAYLOAD_BYTES + 1),
            BatchPush::DroppedTooLarge
        );
        assert_eq!(batch.len(), 0);
    }

    #[test]
    fn bounded_batch_memory_flushes_before_accepting_another_large_message() {
        let mut batch = MessageBatch::default();
        assert_eq!(
            batch.push(event(vec![1]), MAX_INBOUND_PAYLOAD_BYTES),
            BatchPush::Queued
        );
        assert!(matches!(
            batch.push(event(vec![2]), MAX_INBOUND_PAYLOAD_BYTES),
            BatchPush::FlushAndQueue(items) if items.len() == 1
        ));
        assert_eq!(batch.len(), 1);
    }

    #[test]
    fn pending_subscribe_and_unsubscribe_complete_by_kind_and_packet_id() {
        let mut pending = PendingOperations::default();
        let subscribe = pending.enqueue("conn-1", 7, OperationKind::Subscribe);
        let unsubscribe = pending.enqueue("conn-1", 7, OperationKind::Unsubscribe);
        pending.assign("conn-1", 7, OperationKind::Subscribe, 11);
        pending.assign("conn-1", 7, OperationKind::Unsubscribe, 12);
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Unsubscribe, 12),
            Some(unsubscribe)
        );
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Subscribe, 11),
            Some(subscribe)
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn assigned_publish_tombstone_survives_retries_and_consumes_only_its_late_ack() {
        let mut pending = PendingOperations::default();
        let old = pending.enqueue("conn-1", 7, OperationKind::Publish);
        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Publish, 10),
            Some(old)
        );
        assert_eq!(pending.expire_connection_for_retry("conn-1", 7), vec![old]);
        assert!(pending.expire_connection_for_retry("conn-1", 7).is_empty());
        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Publish, 10),
            None
        );
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Publish, 10),
            None
        );

        let live = pending.enqueue("conn-1", 7, OperationKind::Publish);
        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Publish, 11),
            Some(live)
        );
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Publish, 11),
            Some(live)
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn publish_completion_matches_each_qos_ack_boundary() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen_sender, seen_receiver) = std::sync::mpsc::channel();
        let (continue_sender, continue_receiver) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            assert_eq!(read_mqtt_packet(&mut stream)[0] >> 4, 1);
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).unwrap();

            let qos0 = read_mqtt_packet(&mut stream);
            assert_eq!(qos0[0] & 0x06, 0);

            let qos1 = read_mqtt_packet(&mut stream);
            assert_eq!(qos1[0] & 0x06, 0x02);
            let qos1_packet_id = publish_packet_id(&qos1);
            seen_sender.send("qos1").unwrap();
            continue_receiver.recv().unwrap();
            stream
                .write_all(&[
                    0x40,
                    0x02,
                    (qos1_packet_id >> 8) as u8,
                    qos1_packet_id as u8,
                ])
                .unwrap();

            let qos2 = read_mqtt_packet(&mut stream);
            assert_eq!(qos2[0] & 0x06, 0x04);
            let qos2_packet_id = publish_packet_id(&qos2);
            seen_sender.send("qos2").unwrap();
            continue_receiver.recv().unwrap();
            stream
                .write_all(&[
                    0x50,
                    0x02,
                    (qos2_packet_id >> 8) as u8,
                    qos2_packet_id as u8,
                ])
                .unwrap();
            let pub_rel = read_mqtt_packet(&mut stream);
            assert_eq!(pub_rel[0], 0x62);
            assert_eq!(u16::from_be_bytes([pub_rel[2], pub_rel[3]]), qos2_packet_id);
            seen_sender.send("pubrel").unwrap();
            continue_receiver.recv().unwrap();
            stream
                .write_all(&[
                    0x70,
                    0x02,
                    (qos2_packet_id >> 8) as u8,
                    qos2_packet_id as u8,
                ])
                .unwrap();
            assert_eq!(read_mqtt_packet(&mut stream)[0] >> 4, 14);
        });

        tauri::async_runtime::block_on(async {
            let service = Arc::new(MqttService::default());
            let sink: SharedMqttEventSink = Arc::new(ControlledSink::new(None, false));
            assert!(
                service
                    .connect(sink.clone(), local_connection(port))
                    .await
                    .ok
            );
            assert!(
                service
                    .publish("conn-1", "qos/0", PublishPayload::Bytes(vec![0]), 0, false)
                    .await
                    .ok
            );

            let qos1_service = service.clone();
            let qos1 = tokio::spawn(async move {
                qos1_service
                    .publish("conn-1", "qos/1", PublishPayload::Bytes(vec![1]), 1, false)
                    .await
            });
            assert_eq!(
                seen_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
                "qos1"
            );
            assert!(!qos1.is_finished());
            continue_sender.send(()).unwrap();
            assert!(
                timeout(Duration::from_secs(2), qos1)
                    .await
                    .unwrap()
                    .unwrap()
                    .ok
            );

            let qos2_service = service.clone();
            let qos2 = tokio::spawn(async move {
                qos2_service
                    .publish("conn-1", "qos/2", PublishPayload::Bytes(vec![2]), 2, false)
                    .await
            });
            assert_eq!(
                seen_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
                "qos2"
            );
            assert!(!qos2.is_finished());
            continue_sender.send(()).unwrap();
            assert_eq!(
                seen_receiver.recv_timeout(Duration::from_secs(2)).unwrap(),
                "pubrel"
            );
            assert!(!qos2.is_finished());
            continue_sender.send(()).unwrap();
            assert!(
                timeout(Duration::from_secs(2), qos2)
                    .await
                    .unwrap()
                    .unwrap()
                    .ok
            );
            assert!(service.disconnect(&sink, "conn-1").await.ok);
        });
        server.join().unwrap();
    }

    #[test]
    fn initial_connecting_sink_failure_stops_before_network_and_clears_service() {
        tauri::async_runtime::block_on(async {
            let service = MqttService::default();
            let sink_impl = ControlledSink::new(Some(0), false);
            let sink: SharedMqttEventSink = Arc::new(sink_impl.clone());
            let result = timeout(
                Duration::from_secs(1),
                service.connect(sink, local_connection(9)),
            )
            .await
            .expect("sink failure cleanup must be bounded");
            assert!(!result.ok);
            assert_eq!(
                result.error.as_deref(),
                Some("injected status sink failure")
            );
            assert!(service.clients.lock().await.is_empty());
            assert!(service.pending.lock().await.operations.is_empty());
            assert_eq!(sink_impl.status_calls.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn connected_status_sink_failure_stops_once_without_a_live_client() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            assert_eq!(read_mqtt_packet(&mut stream)[0] >> 4, 1);
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).unwrap();
            let mut byte = [0_u8; 1];
            let _ = stream.read(&mut byte);
        });
        tauri::async_runtime::block_on(async {
            let service = MqttService::default();
            let sink_impl = ControlledSink::new(Some(1), false);
            let sink: SharedMqttEventSink = Arc::new(sink_impl.clone());
            let result = timeout(
                Duration::from_secs(2),
                service.connect(sink, local_connection(port)),
            )
            .await
            .expect("connected sink failure must settle");
            assert!(!result.ok);
            assert_eq!(
                result.error.as_deref(),
                Some("injected status sink failure")
            );
            assert!(service.clients.lock().await.is_empty());
            assert_eq!(sink_impl.status_calls.load(Ordering::SeqCst), 2);
        });
        server.join().unwrap();
    }

    #[test]
    fn message_sink_failure_terminates_the_connection_without_status_storm() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            assert_eq!(read_mqtt_packet(&mut stream)[0] >> 4, 1);
            stream.write_all(&[0x20, 0x02, 0x00, 0x00]).unwrap();
            std::thread::sleep(Duration::from_millis(50));
            stream
                .write_all(&[
                    0x30, 0x0c, 0x00, 0x09, b's', b'i', b'n', b'k', b'/', b'f', b'a', b'i', b'l',
                    b'x',
                ])
                .unwrap();
            let mut byte = [0_u8; 1];
            let _ = stream.read(&mut byte);
        });
        tauri::async_runtime::block_on(async {
            let service = MqttService::default();
            let sink_impl = ControlledSink::new(None, true);
            let sink: SharedMqttEventSink = Arc::new(sink_impl.clone());
            assert!(service.connect(sink, local_connection(port)).await.ok);
            timeout(Duration::from_secs(2), async {
                while !service.clients.lock().await.is_empty() {
                    sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("message sink failure must remove the client");
            assert_eq!(sink_impl.status_calls.load(Ordering::SeqCst), 2);
            assert!(service.pending.lock().await.operations.is_empty());
        });
        server.join().unwrap();
    }

    #[test]
    fn expired_unassigned_operation_consumes_only_its_own_outgoing_packet() {
        let mut pending = PendingOperations::default();
        let expired = pending.enqueue("conn-1", 7, OperationKind::Subscribe);
        pending.expire_id(expired);
        let live = pending.enqueue("conn-1", 7, OperationKind::Subscribe);

        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Subscribe, 11),
            None
        );
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Subscribe, 11),
            None
        );
        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Subscribe, 12),
            Some(live)
        );
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Subscribe, 12),
            Some(live)
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn expired_assigned_operation_ignores_its_late_ack() {
        let mut pending = PendingOperations::default();
        let expired = pending.enqueue("conn-1", 7, OperationKind::Unsubscribe);
        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Unsubscribe, 11),
            Some(expired)
        );
        pending.expire_id(expired);
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Unsubscribe, 11),
            None
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn retry_failure_preserves_unassigned_replay_order_before_new_live_work() {
        let mut pending = PendingOperations::default();
        let old = pending.enqueue("conn-1", 7, OperationKind::Subscribe);
        assert_eq!(pending.expire_connection_for_retry("conn-1", 7), vec![old]);
        let new = pending.enqueue("conn-1", 7, OperationKind::Subscribe);

        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Subscribe, 11),
            None
        );
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Subscribe, 11),
            None
        );
        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Subscribe, 12),
            Some(new)
        );
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Subscribe, 12),
            Some(new)
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn assigned_subscription_failure_does_not_consume_the_next_new_outgoing() {
        let mut pending = PendingOperations::default();
        let old = pending.enqueue("conn-1", 7, OperationKind::Subscribe);
        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Subscribe, 10),
            Some(old)
        );
        assert_eq!(pending.expire_connection_for_retry("conn-1", 7), vec![old]);
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Subscribe, 10),
            None
        );

        let new = pending.enqueue("conn-1", 7, OperationKind::Subscribe);
        assert_eq!(
            pending.assign("conn-1", 7, OperationKind::Subscribe, 11),
            Some(new)
        );
        assert_eq!(
            pending.complete("conn-1", 7, OperationKind::Subscribe, 11),
            Some(new)
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn rumqttc_does_not_replay_an_assigned_subscription_after_reconnect() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            first
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            assert_eq!(read_mqtt_packet(&mut first)[0] >> 4, 1);
            first.write_all(&[0x20, 0x02, 0x00, 0x00]).unwrap();
            let old_subscribe = read_mqtt_packet(&mut first);
            assert_eq!(old_subscribe[0] >> 4, 8);
            assert_eq!(subscription_topic(&old_subscribe), "old/topic");
            drop(first);

            let (mut second, _) = listener.accept().unwrap();
            second
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            assert_eq!(read_mqtt_packet(&mut second)[0] >> 4, 1);
            second.write_all(&[0x20, 0x02, 0x01, 0x00]).unwrap();
            let new_subscribe = read_mqtt_packet(&mut second);
            assert_eq!(new_subscribe[0] >> 4, 8);
            assert_eq!(subscription_topic(&new_subscribe), "new/topic");
            let payload = mqtt_payload_offset(&new_subscribe);
            second
                .write_all(&[
                    0x90,
                    0x03,
                    new_subscribe[payload],
                    new_subscribe[payload + 1],
                    0x00,
                ])
                .unwrap();
            done_receiver.recv_timeout(Duration::from_secs(3)).unwrap();
        });

        tauri::async_runtime::block_on(async {
            timeout(Duration::from_secs(5), async {
                let mut options = MqttOptions::new("replay-test", "127.0.0.1", port);
                options.set_clean_session(false);
                let (client, mut event_loop) = AsyncClient::new(options, 4);
                assert!(matches!(
                    event_loop.poll().await.unwrap(),
                    Event::Incoming(Packet::ConnAck(_))
                ));

                let mut pending = PendingOperations::default();
                let old = pending.enqueue("conn-1", 7, OperationKind::Subscribe);
                client
                    .subscribe("old/topic", QoS::AtLeastOnce)
                    .await
                    .unwrap();
                let old_packet_id = loop {
                    if let Event::Outgoing(Outgoing::Subscribe(packet_id)) =
                        event_loop.poll().await.unwrap()
                    {
                        break packet_id;
                    }
                };
                assert_eq!(
                    pending.assign("conn-1", 7, OperationKind::Subscribe, old_packet_id),
                    Some(old)
                );
                event_loop.poll().await.expect_err("broker closed socket");
                assert_eq!(pending.expire_connection_for_retry("conn-1", 7), vec![old]);

                loop {
                    if matches!(
                        event_loop.poll().await.unwrap(),
                        Event::Incoming(Packet::ConnAck(_))
                    ) {
                        break;
                    }
                }

                let new = pending.enqueue("conn-1", 7, OperationKind::Subscribe);
                client
                    .subscribe("new/topic", QoS::AtLeastOnce)
                    .await
                    .unwrap();
                let new_packet_id = loop {
                    if let Event::Outgoing(Outgoing::Subscribe(packet_id)) =
                        event_loop.poll().await.unwrap()
                    {
                        break packet_id;
                    }
                };
                assert_eq!(
                    pending.assign("conn-1", 7, OperationKind::Subscribe, new_packet_id),
                    Some(new)
                );
                let sub_ack = loop {
                    if let Event::Incoming(Packet::SubAck(sub_ack)) =
                        event_loop.poll().await.unwrap()
                    {
                        break sub_ack;
                    }
                };
                assert_eq!(sub_ack.pkid, new_packet_id);
                assert_eq!(
                    pending.complete("conn-1", 7, OperationKind::Subscribe, sub_ack.pkid),
                    Some(new)
                );
                assert!(pending.is_empty());
                done_sender.send(()).unwrap();
            })
            .await
            .expect("local reconnect sequence must finish without the command timeout");
        });
        server.join().unwrap();
    }

    #[test]
    fn repeated_retry_is_bounded_and_permanent_stop_clears_tombstones() {
        let mut pending = PendingOperations::default();
        let old = pending.enqueue("conn-1", 7, OperationKind::Subscribe);
        assert_eq!(pending.expire_connection_for_retry("conn-1", 7), vec![old]);
        assert!(pending.expire_connection_for_retry("conn-1", 7).is_empty());
        let key = OperationKey {
            conn_id: "conn-1".into(),
            generation: 7,
            kind: OperationKind::Subscribe,
        };
        assert_eq!(pending.unassigned.get(&key).unwrap().len(), 1);

        assert!(pending.clear_connection("conn-1", 7).is_empty());
        assert!(pending.is_empty());
    }

    #[test]
    fn pending_operations_fail_once_on_replacement_or_disconnect() {
        let mut pending = PendingOperations::default();
        let expired = pending.enqueue("conn-1", 3, OperationKind::Subscribe);
        pending.expire_id(expired);
        pending.enqueue("conn-1", 3, OperationKind::Subscribe);
        pending.enqueue("conn-1", 4, OperationKind::Unsubscribe);
        assert_eq!(pending.clear_connection("conn-1", 3).len(), 1);
        assert_eq!(pending.clear_connection("conn-1", 3).len(), 0);
        assert_eq!(pending.clear_connection("conn-1", 4).len(), 1);
        assert!(pending.is_empty());
    }

    #[test]
    fn starting_generation_replacement_and_disconnect_are_exactly_once() {
        tauri::async_runtime::block_on(async {
            let service = MqttService::default();
            let (previous, first) = service.reserve_generation("conn-1", 1).await;
            assert!(previous.is_none());
            assert!(first.allows_status());

            let (previous, second) = service.reserve_generation("conn-1", 2).await;
            assert!(previous.is_none());
            assert!(!first.allows_status());
            assert!(second.allows_status());
            assert_eq!(service.clients.lock().await.len(), 1);

            let removed = service.clients.lock().await.remove("conn-1");
            assert!(matches!(
                removed,
                Some(ClientSlot::Starting { generation: 2 })
            ));
            remove_identity_if_current(&service.identities, "conn-1", 2);
            assert!(!second.allows_status());
            assert!(service.clients.lock().await.is_empty());
            assert!(service.clients.lock().await.remove("conn-1").is_none());
            assert!(service.clients.lock().await.is_empty());
        });
    }
}
