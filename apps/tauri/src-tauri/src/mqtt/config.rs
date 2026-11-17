// Input limits and MQTT URL/options construction; no network or session ownership.
use super::*;

pub(super) fn validate_nonblank(value: &str, label: &str, max_bytes: usize) -> Result<(), String> {
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

pub(super) fn validate_connection(input: &MqttConnectionInput) -> Result<(), String> {
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

pub(super) fn validate_conn_id(conn_id: &str) -> Result<(), String> {
    validate_nonblank(conn_id, "connection id", MAX_CONNECTION_ID_BYTES)
}

pub(super) fn validate_topic(topic: &str, allow_wildcards: bool) -> Result<(), String> {
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

pub(super) fn normalize_protocol(protocol: &str) -> Result<&'static str, String> {
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

pub(super) fn build_broker_url(input: &MqttConnectionInput) -> Result<String, String> {
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

pub(super) fn build_mqtt_options(input: &MqttConnectionInput) -> Result<MqttOptions, String> {
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
