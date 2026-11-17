mod config;
mod diagnostics;
use config::*;
use diagnostics::*;

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
#[path = "mqtt/tests.rs"]
mod tests;
