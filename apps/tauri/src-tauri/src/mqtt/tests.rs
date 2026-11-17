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
                0x30, 0x0c, 0x00, 0x09, b's', b'i', b'n', b'k', b'/', b'f', b'a', b'i', b'l', b'x',
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
                if let Event::Incoming(Packet::SubAck(sub_ack)) = event_loop.poll().await.unwrap() {
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
