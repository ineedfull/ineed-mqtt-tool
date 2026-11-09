/* global TextEncoder */

export const MQTT_STATUSES = Object.freeze([
  'connecting',
  'connected',
  'reconnecting',
  'disconnected',
  'offline',
  'error',
]);

export const MQTT_ERROR_CODES = Object.freeze([
  'AUTH_FAILED',
  'DNS_FAILED',
  'TLS_FAILED',
  'CONNECTION_RESET',
  'CONNECTION_REFUSED',
  'KEEPALIVE_TIMEOUT',
  'CONNECTION_TIMEOUT',
  'SOCKET_CLOSED',
  'INVALID_CONFIG',
  'UNKNOWN_DISCONNECT',
]);

export function normalizeQos(value) {
  const validNumber = typeof value === 'number' && (value === 0 || value === 1 || value === 2);
  const validString = value === '0' || value === '1' || value === '2';

  if (!validNumber && !validString) {
    throw new TypeError('QoS must be 0, 1, or 2');
  }

  return Number(value);
}

function toBytes(payload) {
  if (payload instanceof Uint8Array) return new Uint8Array(payload);
  if (Array.isArray(payload)) {
    for (let index = 0; index < payload.length; index += 1) {
      const byte = payload[index];

      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new TypeError('MQTT payload bytes must be integers from 0 to 255');
      }
    }

    return Uint8Array.from(payload);
  }
  if (typeof payload === 'string') return new TextEncoder().encode(payload);
  throw new TypeError('MQTT payload must be a string, byte array, or Uint8Array');
}

function normalizeTimestamp(value) {
  let timestamp;

  try {
    timestamp = Number(value);
  } catch {
    throw new TypeError('MQTT timestamp must be finite');
  }

  if (!Number.isFinite(timestamp)) {
    throw new TypeError('MQTT timestamp must be finite');
  }

  return timestamp;
}

function normalizeAttempt(value) {
  let attempt;

  try {
    attempt = Number(value);
  } catch {
    return 0;
  }

  return Number.isFinite(attempt) && attempt >= 0 ? attempt : 0;
}

function normalizeDisconnectedAt(value) {
  if (value == null) return null;

  let disconnectedAt;

  try {
    disconnectedAt = Number(value);
  } catch {
    return null;
  }

  return Number.isFinite(disconnectedAt) ? disconnectedAt : null;
}

function normalizeOptionalDelay(value) {
  if (value == null) return null;
  let delay;
  try {
    delay = Number(value);
  } catch {
    return null;
  }
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}

export function normalizeMessageBatch(input) {
  const messages = Array.isArray(input) ? input : [input];

  return messages.map((message) => {
    const normalized = {
      connId: String(message.connId),
      topic: String(message.topic),
      payload: toBytes(message.payload),
      qos: normalizeQos(message.qos),
      retained: Boolean(message.retained),
      timestamp: normalizeTimestamp(message.timestamp),
    };

    if (message.historyPersisted === true) normalized.historyPersisted = true;

    if (message.payloadText !== undefined) {
      normalized.payloadText = String(message.payloadText);
    }

    return normalized;
  });
}

export function normalizeMqttStatus(input) {
  return {
    connId: String(input.connId),
    status: String(input.status),
    source: String(input.source ?? 'unknown'),
    code: String(input.code ?? ''),
    reason: String(input.reason ?? ''),
    reconnected: Boolean(input.reconnected),
    attempt: normalizeAttempt(input.attempt),
    nextDelayMs: normalizeOptionalDelay(input.nextDelayMs),
    disconnectedAt: normalizeDisconnectedAt(input.disconnectedAt),
  };
}
