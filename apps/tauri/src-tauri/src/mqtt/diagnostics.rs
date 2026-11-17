// Converts broker/transport errors to stable diagnostics and retry decisions.
use super::*;

pub(super) fn classify_mqtt_error(error: impl ToString) -> MqttDiagnostic {
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

pub(super) fn is_retryable_diagnostic(diagnostic: &MqttDiagnostic) -> bool {
    !matches!(diagnostic.source.as_str(), "broker" | "client")
}

pub(super) struct ClassifiedConnectionError {
    pub(super) diagnostic: MqttDiagnostic,
    pub(super) retryable: bool,
}

pub(super) fn classify_connection_error(error: &ConnectionError) -> ClassifiedConnectionError {
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
