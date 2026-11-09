'use strict';

function errorReason(error) {
  try {
    if (typeof error === 'string') return error;
    if (typeof error?.message === 'string' && error.message) return error.message;
    return String(error || 'Unknown MQTT error');
  } catch {
    return 'Unknown MQTT error';
  }
}

function classifyMqttError(error) {
  const reason = errorReason(error);
  const text = reason.toLowerCase();
  if (/not authorized|bad user|bad username|authentication|connack.*(?:4|5)/.test(text)) {
    return { source: 'broker', code: 'AUTH_FAILED', reason: 'authentication failed' };
  }
  if (/enotfound|eai_again|getaddrinfo|dns/.test(text)) {
    return { source: 'network', code: 'DNS_FAILED', reason };
  }
  if (/certificate|self.signed|tls|ssl|unable to verify/.test(text)) {
    return { source: 'client', code: 'TLS_FAILED', reason };
  }
  if (/socket hang up|econnreset|connection reset/.test(text)) {
    return { source: 'network', code: 'CONNECTION_RESET', reason };
  }
  if (/econnrefused|connection refused/.test(text)) {
    return { source: 'network', code: 'CONNECTION_REFUSED', reason };
  }
  if (/keep.?alive|ping.*timeout/.test(text)) {
    return { source: 'network', code: 'KEEPALIVE_TIMEOUT', reason };
  }
  if (/etimedout|timeout|timed out/.test(text)) {
    return { source: 'network', code: 'CONNECTION_TIMEOUT', reason };
  }
  if (/closed|offline|end of stream|connection lost/.test(text)) {
    return { source: 'network', code: 'SOCKET_CLOSED', reason };
  }
  if (/invalid|unsupported|malformed|protocol/.test(text)) {
    return { source: 'client', code: 'INVALID_CONFIG', reason };
  }
  return { source: 'unknown', code: 'UNKNOWN_DISCONNECT', reason };
}

function createMqttStatus(connId, status, details = {}) {
  return {
    connId,
    status,
    source: details.source || 'unknown',
    code: details.code || '',
    reason: details.reason || '',
    reconnected: Boolean(details.reconnected),
    attempt: Number(details.attempt) || 0,
    nextDelayMs: details.nextDelayMs == null ? null : Number(details.nextDelayMs),
    disconnectedAt: details.disconnectedAt == null
      ? null
      : Number(details.disconnectedAt),
  };
}

module.exports = { classifyMqttError, createMqttStatus };
