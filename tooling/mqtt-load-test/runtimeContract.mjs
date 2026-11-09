import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createElectronHarness } from './electronHarness.mjs';
import { startLocalBroker } from './localBroker.mjs';
import { createTauriHarness } from './tauriHarness.mjs';

const SCENARIOS = Object.freeze([
  'plain-tcp-connect',
  'bad-credentials',
  'topic-filters',
  'unsubscribe-cancellation',
  'retained-late-subscribe',
  'binary-payload',
  'qos-boundaries',
  'clean-disconnect',
  'forced-drop-reconnect-resubscribe',
  'independent-connections',
]);

const CONNECTING = { status: 'connecting', source: 'client', code: 'CONNECTING', reason: '', reconnected: false, attempt: 0, nextDelayMs: null, disconnectedAt: null };
const CONNECTED = { status: 'connected', source: 'unknown', code: '', reason: '', reconnected: false, attempt: 0, nextDelayMs: null, disconnectedAt: null };
const DISCONNECTED = { status: 'disconnected', source: 'user', code: 'USER_DISCONNECTED', reason: 'connection closed by user', reconnected: false, attempt: 0, nextDelayMs: null, disconnectedAt: null };
const AUTH_ERROR = { status: 'error', source: 'broker', code: 'AUTH_FAILED', reason: 'authentication failed', reconnected: false, attempt: 0, nextDelayMs: null, disconnectedAt: null };
const RECONNECTING = { status: 'reconnecting', source: 'network', code: 'SOCKET_CLOSED', reason: 'connection closed', reconnected: false, attempt: 1, nextDelayMs: 1_000, disconnectedAt: '<iso-timestamp>' };
const RECONNECTED = { status: 'connected', source: 'unknown', code: '', reason: '', reconnected: true, attempt: 1, nextDelayMs: null, disconnectedAt: '<iso-timestamp>' };

const operation = (name, details = {}) => ({ operation: name, ...details });
const message = (topic, payloadHex, qos, retained) => ({
  topic, payloadHex, byteLength: payloadHex.length / 2, qos, retained, timestamp: '<iso-timestamp>',
});
const standardStatuses = () => [{ ...CONNECTING }, { ...CONNECTED }, { ...DISCONNECTED }];
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const EXPECTED_PROJECTIONS = deepFreeze({
  'plain-tcp-connect': {
    operations: [operation('connect', { result: { ok: true } }), operation('disconnect', { result: { ok: true } })],
    statuses: standardStatuses(),
    messages: [],
  },
  'bad-credentials': {
    operations: [operation('connect', { result: { ok: false, code: 'AUTH_FAILED' } })],
    statuses: [{ ...CONNECTING }, { ...AUTH_ERROR }],
    messages: [],
  },
  'topic-filters': {
    operations: [
      operation('connect', { result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/exact', qos: 1, result: { ok: true } }),
      operation('publish', { topic: '<topic>/exact', payloadHex: '6578616374', qos: 1, retained: false, result: { ok: true } }),
      operation('unsubscribe', { topic: '<topic>/exact', result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/+/status', qos: 1, result: { ok: true } }),
      operation('publish', { topic: '<topic>/device/status', payloadHex: '706c7573', qos: 1, retained: false, result: { ok: true } }),
      operation('unsubscribe', { topic: '<topic>/+/status', result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/deep/#', qos: 1, result: { ok: true } }),
      operation('publish', { topic: '<topic>/deep/a/b', payloadHex: '68617368', qos: 1, retained: false, result: { ok: true } }),
      operation('unsubscribe', { topic: '<topic>/deep/#', result: { ok: true } }),
      operation('disconnect', { result: { ok: true } }),
    ],
    statuses: standardStatuses(),
    messages: [
      message('<topic>/exact', '6578616374', 1, false),
      message('<topic>/device/status', '706c7573', 1, false),
      message('<topic>/deep/a/b', '68617368', 1, false),
    ],
  },
  'unsubscribe-cancellation': {
    operations: [
      operation('connect', { result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/cancel', qos: 0, result: { ok: true } }),
      operation('publish', { topic: '<topic>/cancel', payloadHex: '01', qos: 0, retained: false, result: { ok: true } }),
      operation('unsubscribe', { topic: '<topic>/cancel', result: { ok: true } }),
      operation('publish', { topic: '<topic>/cancel', payloadHex: '02', qos: 0, retained: false, result: { ok: true } }),
      operation('disconnect', { result: { ok: true } }),
    ],
    statuses: standardStatuses(),
    messages: [message('<topic>/cancel', '01', 0, false)],
  },
  'retained-late-subscribe': {
    operations: [
      operation('connect', { result: { ok: true } }),
      operation('publish', { topic: '<topic>/retained', payloadHex: '72', qos: 1, retained: true, result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/retained', qos: 1, result: { ok: true } }),
      operation('unsubscribe', { topic: '<topic>/retained', result: { ok: true } }),
      operation('publish', { topic: '<topic>/retained', payloadHex: '', qos: 1, retained: true, result: { ok: true } }),
      operation('disconnect', { result: { ok: true } }),
    ],
    statuses: standardStatuses(),
    messages: [message('<topic>/retained', '72', 1, true)],
  },
  'binary-payload': {
    operations: [
      operation('connect', { result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/binary', qos: 1, result: { ok: true } }),
      operation('publish', { topic: '<topic>/binary', payloadHex: '00ff01fe', qos: 1, retained: false, result: { ok: true } }),
      operation('disconnect', { result: { ok: true } }),
    ],
    statuses: standardStatuses(),
    messages: [message('<topic>/binary', '00ff01fe', 1, false)],
  },
  'qos-boundaries': {
    operations: [
      operation('connect', { result: { ok: true } }),
      ...[0, 1, 2].flatMap(qos => [
        operation('subscribe', { topic: `<topic>/qos/${qos}`, qos, result: { ok: true } }),
        operation('publish', { topic: `<topic>/qos/${qos}`, payloadHex: `0${qos}`, qos, retained: false, result: { ok: true } }),
      ]),
      operation('disconnect', { result: { ok: true } }),
    ],
    statuses: standardStatuses(),
    messages: [0, 1, 2].map(qos => message(`<topic>/qos/${qos}`, `0${qos}`, qos, false)),
  },
  'clean-disconnect': {
    operations: [operation('connect', { result: { ok: true } }), operation('disconnect', { result: { ok: true } })],
    statuses: standardStatuses(),
    messages: [],
  },
  'forced-drop-reconnect-resubscribe': {
    operations: [
      operation('connect', { result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/reconnect', qos: 1, result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/reconnect', qos: 1, result: { ok: true } }),
      operation('publish', { topic: '<topic>/reconnect', payloadHex: 'aa', qos: 1, retained: false, result: { ok: true } }),
      operation('disconnect', { result: { ok: true } }),
    ],
    statuses: [{ ...CONNECTING }, { ...CONNECTED }, { ...RECONNECTING }, { ...RECONNECTED }, { ...DISCONNECTED }],
    messages: [message('<topic>/reconnect', 'aa', 1, false)],
  },
  'independent-connections': {
    operations: [
      operation('connect', { result: { ok: true } }), operation('connect', { result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/only/a', qos: 1, result: { ok: true } }),
      operation('subscribe', { topic: '<topic>/only/b', qos: 1, result: { ok: true } }),
      operation('publish', { topic: '<topic>/only/a', payloadHex: 'a1', qos: 1, retained: false, result: { ok: true } }),
      operation('publish', { topic: '<topic>/only/b', payloadHex: 'b2', qos: 1, retained: false, result: { ok: true } }),
      operation('disconnect', { result: { ok: true } }), operation('disconnect', { result: { ok: true } }),
    ],
    statuses: [...standardStatuses(), ...standardStatuses()],
    messages: [message('<topic>/only/a', 'a1', 1, false), message('<topic>/only/b', 'b2', 1, false)],
  },
});

function normalizeResult(input) {
  return input?.ok === true
    ? { ok: true }
    : { ok: false, error: String(input?.error || 'unknown MQTT error') };
}

function normalizeTopic(value, prefix) {
  return String(value).replace(prefix, '<topic>');
}

function operationDetails(name, args, prefix) {
  if (name === 'subscribe') return { topic: normalizeTopic(args[1], prefix), qos: Number(args[2]) };
  if (name === 'unsubscribe') return { topic: normalizeTopic(args[1], prefix) };
  if (name === 'publish') {
    return {
      topic: normalizeTopic(args[1], prefix),
      payloadHex: Buffer.from(typeof args[2] === 'string' ? Buffer.from(args[2]) : args[2]).toString('hex'),
      qos: Number(args[3]),
      retained: Boolean(args[4]),
    };
  }
  return {};
}

function projectStatus(event) {
  let disconnectedAt = null;
  if (event.disconnectedAt !== null) {
    assert.ok(Number.isFinite(event.disconnectedAt) && event.disconnectedAt > 0);
    assert.equal(Number.isNaN(Date.parse(new Date(event.disconnectedAt).toISOString())), false);
    disconnectedAt = '<iso-timestamp>';
  }
  return {
    status: event.status,
    source: event.source,
    code: event.code,
    reason: event.reason,
    reconnected: event.reconnected,
    attempt: event.attempt,
    nextDelayMs: event.nextDelayMs,
    disconnectedAt,
  };
}

function projectMessage(event, prefix) {
  const isoTimestamp = new Date(event.timestamp).toISOString();
  assert.equal(Number.isNaN(Date.parse(isoTimestamp)), false);
  return {
    topic: normalizeTopic(event.topic, prefix),
    payloadHex: event.payloadHex,
    byteLength: event.byteLength,
    qos: event.qos,
    retained: event.retained,
    timestamp: '<iso-timestamp>',
  };
}

function createScenarioRecorder(runtime, prefix, signal) {
  const start = runtime.events.length;
  const operations = [];
  const connectionIds = [];
  return Object.freeze({
    runtime: runtime.runtime,
    events: runtime.events,
    async command(name, ...args) {
      if (name === 'connect') connectionIds.push(args[0].id);
      const entry = operation(name, operationDetails(name, args, prefix));
      operations.push(entry);
      const raw = await runtime.command(name, ...args, { signal });
      const normalized = normalizeResult(raw);
      if (normalized.ok) {
        entry.result = { ok: true };
      } else {
        const connId = name === 'connect' ? args[0].id : args[0];
        const terminal = runtime.events.findLast(event => (
          event.type === 'status' && event.connId === connId && event.code
        ));
        entry.result = { ok: false, code: terminal?.code || 'UNKNOWN_DISCONNECT' };
      }
      return raw;
    },
    waitMessage(predicate, timeoutMs) {
      return runtime.waitMessage(predicate, timeoutMs, signal);
    },
    waitStatus(predicate, timeoutMs) {
      return runtime.waitStatus(predicate, timeoutMs, signal);
    },
    expectNoMessage(predicate, durationMs) {
      return runtime.expectNoMessage(predicate, durationMs, signal);
    },
    project() {
      const scenarioEvents = runtime.events.slice(start);
      const statuses = connectionIds.flatMap(connId => {
        const rawStatuses = scenarioEvents
          .filter(event => event.type === 'status' && event.connId === connId)
          .filter(event => !(event.status === 'reconnecting' && event.attempt === 0));
        const reconnecting = rawStatuses.find(event => event.status === 'reconnecting');
        const reconnected = rawStatuses.find(event => event.status === 'connected' && event.reconnected);
        if (reconnecting || reconnected) {
          assert.equal(reconnecting?.disconnectedAt, reconnected?.disconnectedAt);
        }
        return rawStatuses.map(projectStatus);
      });
      const messages = scenarioEvents
        .filter(event => event.type === 'message' && connectionIds.includes(event.connId))
        .toSorted((left, right) => (
          connectionIds.length > 1
            ? connectionIds.indexOf(left.connId) - connectionIds.indexOf(right.connId)
            : 0
        ))
        .map(event => projectMessage(event, prefix));
      return { operations, statuses, messages };
    },
  });
}

function within(operation, timeoutMs, label) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function abortableDelay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = (operation, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      operation(value);
    };
    const timer = setTimeout(() => finish(resolve), delayMs);
    const abort = () => {
      clearTimeout(timer);
      finish(reject, signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function awaitSettlement(operation, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runScenarioSequence({
  names,
  execute,
  cleanup,
  timeoutMs,
  settleTimeoutMs = 500,
  cleanupTimeoutMs = 6_000,
}) {
  const results = [];
  let primaryError = null;
  try {
    for (const name of names) {
      const controller = new AbortController();
      let timer;
      const running = Promise.resolve().then(() => execute(name, { signal: controller.signal }));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${name} exceeded ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      try {
        results.push(await Promise.race([running, timeout]));
      } catch (error) {
        controller.abort(error);
        await awaitSettlement(running, settleTimeoutMs);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try {
    await within(Promise.resolve().then(cleanup), cleanupTimeoutMs, 'MQTT runtime cleanup');
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError) {
    if (cleanupError) primaryError.cleanupError = cleanupError;
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return results;
}

function connection(broker, id, overrides = {}) {
  return {
    id,
    name: id,
    protocol: 'mqtt',
    host: broker.host,
    port: broker.port,
    path: '',
    clientId: `client-${id}`,
    username: broker.username,
    password: broker.password,
    keepalive: 2,
    cleanSession: true,
    autoReconnect: false,
    ...overrides,
  };
}

function assertOk(input) {
  assert.deepEqual(normalizeResult(input), { ok: true });
}

function assertMessage(message, expected) {
  assert.equal(message.connId, expected.connId);
  assert.equal(message.topic, expected.topic);
  assert.equal(message.payloadHex, expected.payloadHex);
  assert.equal(message.byteLength, expected.payloadHex.length / 2);
  assert.equal(message.qos, expected.qos);
  assert.equal(message.retained, expected.retained);
  assert.ok(Number.isFinite(message.timestamp));
}

async function withConnection(runtime, broker, id, overrides, action) {
  assertOk(await runtime.command('connect', connection(broker, id, overrides)));
  try {
    return await action();
  } finally {
    await runtime.command('disconnect', id);
  }
}

async function executeScenario(name, { runtime, broker, prefix, signal }) {
  const connId = `${runtime.runtime}-${randomUUID()}`;
  switch (name) {
    case 'plain-tcp-connect': {
      assertOk(await runtime.command('connect', connection(broker, connId)));
      const statuses = runtime.events.filter(event => event.type === 'status' && event.connId === connId);
      assert.deepEqual(statuses.slice(0, 2).map(event => event.status), ['connecting', 'connected']);
      assert.equal(statuses[1].reconnected, false);
      assert.equal(typeof statuses[0].code, 'string');
      assertOk(await runtime.command('disconnect', connId));
      return;
    }
    case 'bad-credentials': {
      const result = normalizeResult(await runtime.command('connect', connection(broker, connId, {
        username: 'bad-user', password: 'bad-password', autoReconnect: false,
      })));
      assert.equal(result.ok, false);
      assert.ok(result.error.length > 0);
      const status = await runtime.waitStatus(event => event.connId === connId && event.code === 'AUTH_FAILED');
      assert.ok(['error', 'offline'].includes(status.status));
      assert.equal(status.source, 'broker');
      return;
    }
    case 'topic-filters': {
      await withConnection(runtime, broker, connId, {}, async () => {
        const expectations = [
          [`${prefix}/exact`, `${prefix}/exact`, '6578616374'],
          [`${prefix}/+/status`, `${prefix}/device/status`, '706c7573'],
          [`${prefix}/deep/#`, `${prefix}/deep/a/b`, '68617368'],
        ];
        for (const [filter, topic, hex] of expectations) {
          assertOk(await runtime.command('subscribe', connId, filter, 1));
          assertOk(await runtime.command('publish', connId, topic, [...Buffer.from(hex, 'hex')], 1, false));
          const message = await runtime.waitMessage(event => event.connId === connId && event.topic === topic && event.payloadHex === hex);
          assertMessage(message, { connId, topic, payloadHex: hex, qos: 1, retained: false });
          assertOk(await runtime.command('unsubscribe', connId, filter));
        }
      });
      return;
    }
    case 'unsubscribe-cancellation': {
      await withConnection(runtime, broker, connId, {}, async () => {
        const topic = `${prefix}/cancel`;
        assertOk(await runtime.command('subscribe', connId, topic, 0));
        assertOk(await runtime.command('publish', connId, topic, [1], 0, false));
        await runtime.waitMessage(event => event.connId === connId && event.topic === topic && event.payloadHex === '01');
        assertOk(await runtime.command('unsubscribe', connId, topic));
        assertOk(await runtime.command('publish', connId, topic, [2], 0, false));
        await runtime.expectNoMessage(event => event.connId === connId && event.topic === topic && event.payloadHex === '02');
      });
      return;
    }
    case 'retained-late-subscribe': {
      await withConnection(runtime, broker, connId, {}, async () => {
        const topic = `${prefix}/retained`;
        assertOk(await runtime.command('publish', connId, topic, [0x72], 1, true));
        assertOk(await runtime.command('subscribe', connId, topic, 1));
        const message = await runtime.waitMessage(event => event.connId === connId && event.topic === topic && event.payloadHex === '72');
        assertMessage(message, { connId, topic, payloadHex: '72', qos: 1, retained: true });
        assertOk(await runtime.command('unsubscribe', connId, topic));
        assertOk(await runtime.command('publish', connId, topic, [], 1, true));
      });
      return;
    }
    case 'binary-payload': {
      await withConnection(runtime, broker, connId, {}, async () => {
        const topic = `${prefix}/binary`;
        assertOk(await runtime.command('subscribe', connId, topic, 1));
        assertOk(await runtime.command('publish', connId, topic, [0, 255, 1, 254], 1, false));
        const message = await runtime.waitMessage(event => event.connId === connId && event.topic === topic);
        assertMessage(message, { connId, topic, payloadHex: '00ff01fe', qos: 1, retained: false });
      });
      return;
    }
    case 'qos-boundaries': {
      await withConnection(runtime, broker, connId, {}, async () => {
        for (const qos of [0, 1, 2]) {
          const topic = `${prefix}/qos/${qos}`;
          assertOk(await runtime.command('subscribe', connId, topic, qos));
          assertOk(await runtime.command('publish', connId, topic, [qos], qos, false));
          const hex = qos.toString(16).padStart(2, '0');
          const message = await runtime.waitMessage(event => event.connId === connId && event.topic === topic && event.payloadHex === hex);
          assertMessage(message, { connId, topic, payloadHex: hex, qos, retained: false });
        }
      });
      return;
    }
    case 'clean-disconnect': {
      assertOk(await runtime.command('connect', connection(broker, connId)));
      assertOk(await runtime.command('disconnect', connId));
      const status = await runtime.waitStatus(event => event.connId === connId && event.status === 'disconnected');
      assert.equal(status.code, 'USER_DISCONNECTED');
      assert.equal(status.source, 'user');
      const sequence = runtime.events
        .filter(event => event.type === 'status' && event.connId === connId)
        .map(event => event.status);
      assert.ok(sequence.indexOf('connected') < sequence.indexOf('disconnected'));
      return;
    }
    case 'forced-drop-reconnect-resubscribe': {
      const clientId = `client-${connId}`;
      const topic = `${prefix}/reconnect`;
      assertOk(await runtime.command('connect', connection(broker, connId, { autoReconnect: true, clientId })));
      try {
        assertOk(await runtime.command('subscribe', connId, topic, 1));
        await broker.waitForClient(clientId, 3_000, signal);
        broker.dropClient(clientId);
        const reconnecting = await runtime.waitStatus(event => event.connId === connId && event.status === 'reconnecting');
        assert.ok(['CONNECTION_RESET', 'SOCKET_CLOSED', 'UNKNOWN_DISCONNECT'].includes(reconnecting.code));
        assert.ok(reconnecting.attempt >= 0);
        const connected = await runtime.waitStatus(event => event.connId === connId && event.status === 'connected' && event.reconnected);
        assert.equal(connected.reconnected, true);
        assertOk(await runtime.command('subscribe', connId, topic, 1));
        assertOk(await runtime.command('publish', connId, topic, [0xaa], 1, false));
        const message = await runtime.waitMessage(event => event.connId === connId && event.topic === topic && event.payloadHex === 'aa');
        assertMessage(message, { connId, topic, payloadHex: 'aa', qos: 1, retained: false });
        const statuses = runtime.events
          .filter(event => event.type === 'status' && event.connId === connId)
          .map(event => event.status);
        assert.ok(statuses.indexOf('reconnecting') < statuses.lastIndexOf('connected'));
      } finally {
        await runtime.command('disconnect', connId);
      }
      return;
    }
    case 'independent-connections': {
      const otherId = `${connId}-other`;
      assertOk(await runtime.command('connect', connection(broker, connId)));
      assertOk(await runtime.command('connect', connection(broker, otherId)));
      try {
        const topicA = `${prefix}/only/a`;
        const topicB = `${prefix}/only/b`;
        assertOk(await runtime.command('subscribe', connId, topicA, 1));
        assertOk(await runtime.command('subscribe', otherId, topicB, 1));
        const start = runtime.events.length;
        assertOk(await runtime.command('publish', connId, topicA, [0xa1], 1, false));
        assertOk(await runtime.command('publish', otherId, topicB, [0xb2], 1, false));
        await runtime.waitMessage(event => event.connId === connId && event.topic === topicA && event.payloadHex === 'a1');
        await runtime.waitMessage(event => event.connId === otherId && event.topic === topicB && event.payloadHex === 'b2');
        await abortableDelay(250, signal);
        const messages = runtime.events.slice(start).filter(event => event.type === 'message');
        assert.equal(messages.some(event => event.connId === connId && event.topic === topicB), false);
        assert.equal(messages.some(event => event.connId === otherId && event.topic === topicA), false);
      } finally {
        await Promise.allSettled([
          runtime.command('disconnect', connId),
          runtime.command('disconnect', otherId),
        ]);
      }
      return;
    }
    default:
      throw new Error(`unknown MQTT contract scenario: ${name}`);
  }
}

export async function runMqttRuntimeContract(runtimeName, {
  scenarioTimeoutMs = 10_000,
  onScenario = () => {},
  onRuntime = () => {},
} = {}) {
  const broker = await startLocalBroker();
  let runtime;
  try {
    runtime = runtimeName === 'electron'
      ? createElectronHarness()
      : runtimeName === 'tauri'
        ? await createTauriHarness()
        : null;
  } catch (error) {
    await broker.close();
    throw error;
  }
  if (!runtime) {
    await broker.close();
    throw new Error(`unsupported MQTT runtime: ${runtimeName}`);
  }
  onRuntime(runtime);
  let runtimeClosed = false;
  let brokerClosed = false;
  const scenarios = await runScenarioSequence({
    names: SCENARIOS,
    timeoutMs: scenarioTimeoutMs,
    settleTimeoutMs: 750,
    cleanupTimeoutMs: 8_000,
    async execute(name, { signal }) {
      const topicPrefix = `contract/${randomUUID()}`;
      const recorder = createScenarioRecorder(runtime, topicPrefix, signal);
      await executeScenario(name, { runtime: recorder, broker, prefix: topicPrefix, signal });
      const projection = recorder.project();
      assert.deepEqual(projection, EXPECTED_PROJECTIONS[name], `${runtimeName}:${name}:exact projection`);
      const outcome = { ok: true };
      onScenario(name, outcome);
      return { name, topicPrefix, projection, outcome };
    },
    async cleanup() {
      try {
        await runtime.close();
        runtimeClosed = true;
      } finally {
        await broker.close();
        brokerClosed = true;
      }
    },
  });
  return {
    runtime: runtimeName,
    scenarios,
    cleanup: { brokerClosed, runtimeClosed, openSockets: broker.openSocketCount },
  };
}
