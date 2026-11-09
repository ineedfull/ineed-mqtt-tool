import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MQTT_ERROR_CODES,
  MQTT_STATUSES,
  normalizeMessageBatch,
  normalizeMqttStatus,
  normalizeQos,
} from '../src/index.js';

test('normalizeQos accepts only MQTT QoS values', () => {
  assert.equal(normalizeQos('2'), 2);
  assert.throws(() => normalizeQos(3), /QoS must be 0, 1, or 2/);
  assert.throws(
    () => normalizeQos(Symbol('invalid')),
    { name: 'TypeError', message: 'QoS must be 0, 1, or 2' },
  );
});

test('normalizeQos rejects coercible non-canonical values', () => {
  for (const value of [null, false, true, '', ' ', [], [1], {}, Number.NaN, Infinity]) {
    assert.throws(
      () => normalizeQos(value),
      { name: 'TypeError', message: 'QoS must be 0, 1, or 2' },
    );
  }
});

test('normalizeMessageBatch emits Uint8Array payloads', () => {
  const [message] = normalizeMessageBatch({ connId: 'c1', topic: 'a/b', payload: [0, 255], qos: 1, retained: false, timestamp: 7 });
  assert.deepEqual(message.payload, new Uint8Array([0, 255]));
  assert.equal(message.timestamp, 7);
});

test('normalizeMessageBatch accepts batches and string payloads', () => {
  const messages = normalizeMessageBatch([
    { connId: 7, topic: 9, payload: 'ok', payloadText: 10, qos: '0', retained: 1, timestamp: '12' },
  ]);

  assert.deepEqual(messages, [{
    connId: '7',
    topic: '9',
    payload: new Uint8Array([111, 107]),
    payloadText: '10',
    qos: 0,
    retained: true,
    timestamp: 12,
  }]);
  assert.throws(
    () => normalizeMessageBatch({ payload: null }),
    /MQTT payload must be a string, byte array, or Uint8Array/,
  );
});

test('normalizeMessageBatch copies byte payload inputs', () => {
  const arrayPayload = [1, 2];
  const typedPayload = new Uint8Array([3, 4]);
  const messages = normalizeMessageBatch([
    { connId: 'c1', topic: 'a', payload: arrayPayload, qos: 0, retained: false, timestamp: 1 },
    { connId: 'c1', topic: 'b', payload: typedPayload, qos: 0, retained: false, timestamp: 2 },
  ]);

  assert.notEqual(messages[1].payload, typedPayload);
  arrayPayload[0] = 9;
  typedPayload[0] = 9;
  assert.deepEqual(messages[0].payload, new Uint8Array([1, 2]));
  assert.deepEqual(messages[1].payload, new Uint8Array([3, 4]));
});

test('normalizeMessageBatch rejects invalid byte arrays', () => {
  const invalidPayloads = [[-1], [256], [1.5], [Number.NaN], ['1'], new Array(1)];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => normalizeMessageBatch({ connId: 'c1', topic: 'a', payload, qos: 0, retained: false, timestamp: 1 }),
      { name: 'TypeError', message: 'MQTT payload bytes must be integers from 0 to 255' },
    );
  }
});

test('normalizeMessageBatch rejects non-finite timestamps', () => {
  for (const timestamp of [Number.NaN, Infinity]) {
    assert.throws(
      () => normalizeMessageBatch({ connId: 'c1', topic: 'a', payload: [], qos: 0, retained: false, timestamp }),
      { name: 'TypeError', message: 'MQTT timestamp must be finite' },
    );
  }
});

test('normalizeMqttStatus creates stable diagnostic fields', () => {
  assert.deepEqual(normalizeMqttStatus({ connId: 'c1', status: 'offline', code: 'DNS_FAILED' }), {
    connId: 'c1', status: 'offline', source: 'unknown', code: 'DNS_FAILED', reason: '', reconnected: false, attempt: 0, nextDelayMs: null, disconnectedAt: null,
  });
});

test('normalizeMqttStatus normalizes supplied diagnostic fields', () => {
  assert.deepEqual(normalizeMqttStatus({
    connId: 7,
    status: 8,
    source: 3,
    code: 4,
    reason: false,
    attempt: 'invalid',
    nextDelayMs: '10',
    disconnectedAt: '9',
  }), {
    connId: '7',
    status: '8',
    source: '3',
    code: '4',
    reason: 'false',
    reconnected: false,
    attempt: 0,
    nextDelayMs: 10,
    disconnectedAt: 9,
  });
});

test('normalizeMqttStatus defaults invalid attempts and disconnect times', () => {
  for (const attempt of [Infinity, Number.NaN, -1]) {
    assert.equal(normalizeMqttStatus({ attempt }).attempt, 0);
  }

  for (const disconnectedAt of [Infinity, Number.NaN, 'invalid']) {
    assert.equal(normalizeMqttStatus({ disconnectedAt }).disconnectedAt, null);
  }
});

test('MQTT lifecycle and error code lists are immutable', () => {
  assert.deepEqual(MQTT_STATUSES, [
    'connecting',
    'connected',
    'reconnecting',
    'disconnected',
    'offline',
    'error',
  ]);
  assert.deepEqual(MQTT_ERROR_CODES, [
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
  assert.ok(Object.isFrozen(MQTT_STATUSES));
  assert.ok(Object.isFrozen(MQTT_ERROR_CODES));
});


test('native history commit marker survives normalization only for literal true', () => {
  for (const value of [true, false, 'true', undefined]) {
    const [m] = normalizeMessageBatch({ connId: 'c', topic: 't', payload: [], qos: 1, retained: false, timestamp: 1, historyPersisted: value });
    assert.equal(m.historyPersisted === true, value === true);
  }
});
