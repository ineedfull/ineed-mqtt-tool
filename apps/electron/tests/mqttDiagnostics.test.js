import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const diagnostics = require('../electron/mqttDiagnostics.cjs');

test('Electron classifies explicit broker and common transport failures', () => {
  assert.deepEqual(diagnostics.classifyMqttError('Not authorized'), {
    source: 'broker', code: 'AUTH_FAILED', reason: 'authentication failed',
  });
  assert.deepEqual(diagnostics.classifyMqttError('getaddrinfo ENOTFOUND mqtt.local'), {
    source: 'network', code: 'DNS_FAILED', reason: 'getaddrinfo ENOTFOUND mqtt.local',
  });
  assert.deepEqual(diagnostics.classifyMqttError('socket hang up'), {
    source: 'network', code: 'CONNECTION_RESET', reason: 'socket hang up',
  });
  assert.deepEqual(diagnostics.classifyMqttError('certificate has expired'), {
    source: 'client', code: 'TLS_FAILED', reason: 'certificate has expired',
  });
});

test('Electron classifies timeout, refusal, keepalive, close, config, and unknown failures', () => {
  const cases = [
    ['connect ETIMEDOUT', 'CONNECTION_TIMEOUT'],
    ['connect ECONNREFUSED', 'CONNECTION_REFUSED'],
    ['keep alive ping timeout', 'KEEPALIVE_TIMEOUT'],
    ['connection closed', 'SOCKET_CLOSED'],
    ['malformed protocol option', 'INVALID_CONFIG'],
    ['surprising failure', 'UNKNOWN_DISCONNECT'],
  ];
  for (const [reason, code] of cases) {
    assert.equal(diagnostics.classifyMqttError(new Error(reason)).code, code);
  }
});

test('Electron status event keeps structured diagnostics and lifecycle metadata', () => {
  assert.deepEqual(diagnostics.createMqttStatus('conn-1', 'reconnecting', {
    source: 'network', code: 'SOCKET_CLOSED', reason: 'closed', attempt: 2,
    disconnectedAt: 123,
  }), {
    connId: 'conn-1', status: 'reconnecting', source: 'network',
    code: 'SOCKET_CLOSED', reason: 'closed', reconnected: false, attempt: 2, nextDelayMs: null,
    disconnectedAt: 123,
  });
});
