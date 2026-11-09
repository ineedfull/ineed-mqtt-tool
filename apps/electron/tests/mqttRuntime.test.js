import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createMqttCoordinator } = require('../electron/main.cjs');
const { createDatabase } = require('../electron/database.cjs');

class FakeClient extends EventEmitter {
  endCalls = [];
  publishCalls = [];
  subscribeCalls = [];
  unsubscribeCalls = [];
  end(force, callback) { this.endCalls.push(force); callback?.(); }
  publish(...args) { this.publishCalls.push(args); args.at(-1)(null); }
  subscribe(...args) { this.subscribeCalls.push(args); args.at(-1)(null, [{ topic: args[0], qos: args[1].qos }]); }
  unsubscribe(...args) { this.unsubscribeCalls.push(args); args.at(-1)(null); }
}

function createFixture({ onSend } = {}) {
  const clients = [];
  const connectCalls = [];
  const events = [];
  const coordinator = createMqttCoordinator({
    mqtt: {
      connect(url, options) {
        connectCalls.push([url, options]);
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    },
    send(channel, payload) {
      events.push([channel, payload]);
      onSend?.(channel, payload);
    },
    setTimer: () => 1,
    clearTimer: () => {},
  });
  return { clients, connectCalls, coordinator, events };
}

test('invalid publish topic names are rejected without reaching the client', async () => {
  const { clients, coordinator } = createFixture();
  const connecting = coordinator.connect({ id: 'topic-safety', host: 'localhost', port: 1883 });
  clients[0].emit('connect');
  await connecting;
  for (const topic of ['bad/#', 'bad/+', 'bad\u0000topic', 'bad\u0001topic', 'a'.repeat(65_536), '中'.repeat(21_846)]) {
    const result = await coordinator.publish('topic-safety', topic, 'test', 0, false);
    assert.equal(result.ok, false, `invalid topic ${topic.slice(0, 20)} must be rejected`);
  }
  assert.equal(clients[0].publishCalls.length, 0);
  assert.equal((await coordinator.publish('topic-safety', '/合法/topic', 'sentinel', 1, false)).ok, true);
  assert.equal(clients[0].publishCalls.length, 1);
  await coordinator.disconnectAll();
});

test('MQTT connect configures reference timeouts and resolves on connect', async () => {
  const { clients, connectCalls, coordinator } = createFixture();
  const result = coordinator.connect({
    id: 'conn-1', protocol: 'mqtt://', host: 'localhost', port: 1883,
    path: '', clientId: 'client-1', keepalive: 30, cleanSession: false,
    autoReconnect: true,
  });
  clients[0].emit('connect');

  assert.deepEqual(await result, { ok: true });
  assert.equal(connectCalls[0][0], 'mqtt://localhost:1883');
  assert.equal(connectCalls[0][1].connectTimeout, 10_000);
  assert.equal(connectCalls[0][1].reconnectPeriod, 1_000);
  assert.equal(connectCalls[0][1].resubscribe, false);
});

test('MQTT connect consumes persisted client_id and zero clean_session from a real database row', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ineed-mqtt-connect-'));
  const database = createDatabase(join(directory, 'mqtt.db'));
  try {
    database.saveConnection({
      id: 'persisted-1',
      name: 'Persisted',
      protocol: 'mqtt',
      host: 'localhost',
      port: 1883,
      client_id: 'persisted-client',
      clean_session: 0,
    });
    const [row] = database.getConnections();
    const { clients, connectCalls, coordinator } = createFixture();
    const result = coordinator.connect(row);
    clients[0].emit('connect');

    assert.deepEqual(await result, { ok: true });
    assert.equal(connectCalls[0][1].clientId, 'persisted-client');
    assert.equal(connectCalls[0][1].clean, false);
  } finally {
    database.closeDatabase();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('initial status delivery failure removes and ends the unreachable client', async () => {
  const { clients, coordinator } = createFixture({
    onSend() { throw new Error('status delivery failed'); },
  });

  const result = await coordinator.connect({
    id: 'conn-1', protocol: 'mqtt', host: 'localhost', port: 1883,
    autoReconnect: false,
  });

  assert.deepEqual(result, { ok: false, error: 'status delivery failed' });
  assert.equal(coordinator.size, 0);
  assert.deepEqual(clients[0].endCalls, [true]);
  assert.equal(clients[0].listenerCount('connect'), 0);
  assert.equal(clients[0].listenerCount('message'), 0);
});

test('non-reconnecting initial errors settle immediately regardless of classification', async () => {
  for (const [index, reason, expectedCode] of [
    [1, 'connect ECONNREFUSED 127.0.0.1:1883', 'CONNECTION_REFUSED'],
    [2, 'unexpected transport failure', 'UNKNOWN_DISCONNECT'],
  ]) {
    const { clients, coordinator, events } = createFixture();
    const result = coordinator.connect({
      id: `conn-${index}`, protocol: 'mqtt', host: 'localhost', port: 1883,
      autoReconnect: false,
    });
    clients[0].emit('error', new Error(reason));

    const outcome = await Promise.race([
      result,
      new Promise(resolvePromise => setImmediate(() => resolvePromise('still pending'))),
    ]);
    assert.deepEqual(outcome, { ok: false, error: reason });
    assert.deepEqual(clients[0].endCalls, [true]);
    assert.equal(coordinator.size, 0);
    assert.equal(events.at(-1)[1].code, expectedCode);
    assert.deepEqual(await coordinator.subscribe(`conn-${index}`, 'topic/#', 0), {
      ok: false, error: 'not connected',
    });
    assert.deepEqual(await coordinator.publish(`conn-${index}`, 'topic', 'value', 0, false), {
      ok: false, error: 'not connected',
    });
  }
});

test('reconnecting mode can recover from an initial network error without stale failure', async () => {
  const { clients, coordinator, events } = createFixture();
  let settled = false;
  const result = coordinator.connect({
    id: 'conn-1', protocol: 'mqtt', host: 'localhost', port: 1883,
    autoReconnect: true,
  });
  result.then(() => { settled = true; });
  clients[0].emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1883'));
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(settled, false);
  assert.deepEqual(clients[0].endCalls, []);

  clients[0].emit('connect');
  assert.deepEqual(await result, { ok: true });
  assert.equal(events.at(-1)[1].status, 'connected');
});

test('non-reconnecting connected clients stop once on error, offline, or close', async () => {
  for (const eventName of ['error', 'offline', 'close']) {
    const { clients, coordinator, events } = createFixture();
    const connecting = coordinator.connect({
      id: 'conn-1', protocol: 'mqtt', host: 'localhost', port: 1883,
      autoReconnect: false,
    });
    clients[0].emit('connect');
    assert.deepEqual(await connecting, { ok: true });
    const statusCount = events.length;

    if (eventName === 'error') clients[0].emit(eventName, new Error('unexpected transport failure'));
    else clients[0].emit(eventName);
    clients[0].emit('offline');
    clients[0].emit('close');
    await new Promise(resolvePromise => setImmediate(resolvePromise));

    assert.equal(coordinator.size, 0, eventName);
    assert.deepEqual(clients[0].endCalls, [true], eventName);
    assert.equal(events.length, statusCount + 1, eventName);
    assert.equal(events.at(-1)[1].status, 'error', eventName);
    assert.deepEqual(await coordinator.publish('conn-1', 'topic', 'value', 0, false), {
      ok: false, error: 'not connected',
    }, eventName);
  }
});

test('terminal status delivery failure is contained across an event storm', async () => {
  const { clients, coordinator } = createFixture({
    onSend(_channel, payload) {
      if (payload.status === 'error') throw new Error('status delivery failed');
    },
  });
  const connecting = coordinator.connect({
    id: 'conn-1', protocol: 'mqtt', host: 'localhost', port: 1883,
    autoReconnect: false,
  });
  clients[0].emit('connect');
  assert.deepEqual(await connecting, { ok: true });

  assert.doesNotThrow(() => clients[0].emit('error', new Error('transport failed')));
  clients[0].emit('offline');
  clients[0].emit('close');
  clients[0].emit('error', new Error('late transport failure'));
  await new Promise(resolvePromise => setImmediate(resolvePromise));

  assert.equal(coordinator.size, 0);
  assert.deepEqual(clients[0].endCalls, [true]);
  for (const eventName of ['connect', 'message', 'reconnect', 'offline', 'close']) {
    assert.equal(clients[0].listenerCount(eventName), 0, eventName);
  }
});

test('disconnect ends once even when disconnected status delivery fails', async () => {
  const { clients, coordinator } = createFixture({
    onSend(_channel, payload) {
      if (payload.status === 'disconnected') throw new Error('status delivery failed');
    },
  });
  const connecting = coordinator.connect({
    id: 'conn-1', protocol: 'mqtt', host: 'localhost', port: 1883,
  });
  clients[0].emit('connect');
  await connecting;

  assert.deepEqual(await coordinator.disconnect('conn-1'), { ok: true });
  assert.equal(coordinator.size, 0);
  assert.deepEqual(clients[0].endCalls, [false]);
});

test('replacing a connection guards against stale client messages and status', async () => {
  const { clients, coordinator, events } = createFixture();
  const first = coordinator.connect({ id: 'conn-1', protocol: 'mqtt', host: 'one', port: 1883 });
  const second = coordinator.connect({ id: 'conn-1', protocol: 'mqtt', host: 'two', port: 1883 });
  assert.deepEqual(await first, { ok: false, error: 'connection replaced' });
  clients[1].emit('connect');
  assert.deepEqual(await second, { ok: true });

  const before = events.length;
  clients[0].emit('message', 'stale/topic', Buffer.from('stale'));
  clients[0].emit('error', new Error('stale'));
  assert.equal(events.length, before);
  assert.deepEqual(clients[0].endCalls, [true]);
});

test('MQTT operations validate state and preserve string and number-array payloads', async () => {
  const { clients, coordinator } = createFixture();
  assert.deepEqual(await coordinator.subscribe('', 'topic', 0), { ok: false, error: 'connection id is required' });
  assert.deepEqual(await coordinator.publish('missing', 'topic', 'text', 0, false), { ok: false, error: 'not connected' });

  const connecting = coordinator.connect({ id: 'conn-1', protocol: 'mqtt', host: 'localhost', port: 1883 });
  clients[0].emit('connect');
  await connecting;
  assert.deepEqual(await coordinator.subscribe('conn-1', 'sensors/#', 1), {
    ok: true, granted: [{ topic: 'sensors/#', qos: 1 }],
  });
  assert.deepEqual(await coordinator.unsubscribe('conn-1', 'sensors/#'), { ok: true });
  assert.deepEqual(await coordinator.publish('conn-1', 'text', 'hello', 0, false), { ok: true });
  assert.equal(clients[0].publishCalls[0][1], 'hello');
  assert.deepEqual(await coordinator.publish('conn-1', 'bytes', [0, 255], 2, true), { ok: true });
  assert.deepEqual([...clients[0].publishCalls[1][1]], [0, 255]);
  assert.deepEqual(await coordinator.publish('conn-1', 'bad', [256], 0, false), {
    ok: false, error: 'payload must be a string or byte array',
  });
});

test('MQTT operation callbacks cannot report success after their client is replaced', async () => {
  const clients = [];
  class DeferredSubscribeClient extends FakeClient {
    subscribe(...args) { this.subscribeCalls.push(args); }
  }
  const coordinator = createMqttCoordinator({
    mqtt: { connect() { const client = new DeferredSubscribeClient(); clients.push(client); return client; } },
    send() {},
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const first = coordinator.connect({ id: 'conn-1', protocol: 'mqtt', host: 'one', port: 1883 });
  clients[0].emit('connect');
  await first;
  const subscribe = coordinator.subscribe('conn-1', 'topic/#', 1);
  const second = coordinator.connect({ id: 'conn-1', protocol: 'mqtt', host: 'two', port: 1883 });
  clients[1].emit('connect');
  await second;
  clients[0].subscribeCalls[0].at(-1)(null, [{ topic: 'topic/#', qos: 1 }]);

  assert.deepEqual(await subscribe, { ok: false, error: 'connection replaced' });
});

test('incoming messages are normalized to payload arrays and emitted in 200ms/200-row batches', async () => {
  let scheduled;
  let scheduledDelay;
  const clients = [];
  const events = [];
  const coordinator = createMqttCoordinator({
    mqtt: { connect() { const client = new FakeClient(); clients.push(client); return client; } },
    send: (channel, payload) => events.push([channel, payload]),
    scheduleBatch: (callback, delay) => { scheduled = callback; scheduledDelay = delay; return 1; },
    clearBatch: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const connecting = coordinator.connect({ id: 'conn-1', protocol: 'mqtt', host: 'localhost', port: 1883 });
  clients[0].emit('connect');
  await connecting;
  clients[0].emit('message', 'sensor/temp', Buffer.from([0, 255]), { qos: 1, retain: true });

  assert.equal(scheduledDelay, 200);
  scheduled();
  const messageEvent = events.find(([channel]) => channel === 'mqtt:messages');
  assert.deepEqual(messageEvent[1][0].payload, [0, 255]);
  assert.equal(messageEvent[1][0].topic, 'sensor/temp');
  assert.equal(messageEvent[1][0].qos, 1);
  assert.equal(messageEvent[1][0].retained, true);
});

test('oversized incoming payloads are dropped before batch scheduling', async () => {
  let scheduled = false;
  const clients = [];
  const events = [];
  const coordinator = createMqttCoordinator({
    mqtt: { connect() { const client = new FakeClient(); clients.push(client); return client; } },
    send: (channel, payload) => events.push([channel, payload]),
    scheduleBatch: () => { scheduled = true; return 1; },
    clearBatch: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const connecting = coordinator.connect({ id: 'conn-1', protocol: 'mqtt', host: 'localhost', port: 1883 });
  clients[0].emit('connect');
  await connecting;
  const statusCount = events.length;

  clients[0].emit('message', 'oversized/topic', Buffer.alloc(8_388_609), { qos: 1 });

  assert.equal(scheduled, false);
  assert.equal(events.length, statusCount + 1);
  assert.deepEqual(events.at(-1)[1], {
    connId: 'conn-1',
    status: 'error',
    source: 'client',
    code: 'PAYLOAD_TOO_LARGE',
    reason: 'Inbound MQTT payload exceeds 8388608 bytes',
    reconnected: false,
    attempt: 0,
    nextDelayMs: null,
    disconnectedAt: null,
  });
});

test('disconnect and shutdown end clients gracefully and flush pending batches', async () => {
  const { clients, coordinator } = createFixture();
  const connecting = coordinator.connect({ id: 'conn-1', protocol: 'mqtt', host: 'localhost', port: 1883 });
  clients[0].emit('connect');
  await connecting;
  assert.deepEqual(await coordinator.disconnect('conn-1'), { ok: true });
  assert.deepEqual(clients[0].endCalls, [false]);

  const next = coordinator.connect({ id: 'conn-2', protocol: 'mqtt', host: 'localhost', port: 1883 });
  clients[1].emit('connect');
  await next;
  await coordinator.disconnectAll();
  assert.deepEqual(clients[1].endCalls, [false]);
  assert.equal(coordinator.size, 0);
});


test('received history is committed before a slow or failed renderer delivery and never saved twice', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ineed-mqtt-native-history-'));
  const db = createDatabase(join(directory, 'mqtt.db'));
  let client;
  let deliveries = 0;
  db.saveConnection({ id: 'native', name: 'Native', host: 'localhost', port: 1883 });
  const coordinator = createMqttCoordinator({
    db,
    mqtt: { connect() { client = new FakeClient(); return client; } },
    send(channel, rows) {
      if (channel !== 'mqtt:messages') return;
      deliveries++;
      assert.ok(db.queryHistoryMessages({ connection_id: 'native' }).total >= rows.length);
      assert.ok(rows.every(row => row.historyPersisted === true));
      if (deliveries === 1) throw new Error('renderer busy');
    },
    scheduleBatch: () => 1, clearBatch: () => {}, setTimer: () => 1, clearTimer: () => {},
  });
  try {
    const connecting = coordinator.connect({ id: 'native', host: 'localhost', port: 1883 });
    client.emit('connect'); await connecting;
    for (let n = 0; n < 5000; n++) client.emit('message', 'load/data', Buffer.from(String(n)), { qos: 1 });
    coordinator.flush(); coordinator.flush(); coordinator.flush();
    assert.equal(db.queryHistoryMessages({ connection_id: 'native' }).total, 5000);
    assert.equal(deliveries, 3);
  } finally { await coordinator.disconnectAll(); coordinator.dispose(); db.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});


test('native history failure closes reception and refuses update flush', async () => {
  let client;
  const events = [];
  const failure = new Error('disk full');
  const coordinator = createMqttCoordinator({
    db: { getAllSettings: () => ({}), getSubscriptions: () => [], saveMessages() { throw failure; } },
    mqtt: { connect() { client = new FakeClient(); return client; } },
    send: (channel, payload) => events.push([channel, payload]),
    scheduleBatch: () => 1, clearBatch: () => {}, setTimer: () => 1, clearTimer: () => {},
  });
  const connecting = coordinator.connect({ id: 'c', host: 'localhost', port: 1883 });
  client.emit('connect'); await connecting;
  client.emit('message', 'load/data', Buffer.from('unsaved'), { qos: 1 });
  assert.throws(() => coordinator.flush(), /disk full/);
  assert.equal(coordinator.size, 0);
  assert.ok(events.some(([channel, payload]) => channel === 'mqtt:status' && payload.code === 'HISTORY_WRITE_FAILED'));
  assert.equal(events.filter(([channel]) => channel === 'mqtt:messages').length, 0);
  await coordinator.disconnectAll();
  assert.throws(() => coordinator.flush(), /disk full/);
  coordinator.dispose();
});


test('disconnect commits a final partial native reception batch before connection deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mqtt-final-batch-'));
  const db = createDatabase(join(dir, 'mqtt.db'));
  db.saveConnection({ id: 'c', name: 'Native', host: 'localhost', port: 1883 });
  let client;
  const coordinator = createMqttCoordinator({ db,
    mqtt: { connect() { client = new FakeClient(); return client; } }, send() {},
    scheduleBatch: () => 1, clearBatch: () => {}, setTimer: () => 1, clearTimer: () => {},
  });
  try {
    const connecting = coordinator.connect({ id: 'c', host: 'localhost', port: 1883 });
    client.emit('connect'); await connecting;
    client.emit('message', 'last', Buffer.from('final'), { qos: 1 });
    await coordinator.disconnect('c');
    assert.equal(db.queryHistoryMessages({}).total, 1);
    db.deleteConnection('c');
    assert.doesNotThrow(() => coordinator.flush());
  } finally { await coordinator.disconnectAll(); coordinator.dispose(); db.closeDatabase(); rmSync(dir, { recursive: true, force: true }); }
});


test('MQTT broker URLs normalize WebSocket paths and both IPv6 host forms', async () => {
  for (const [protocol, host, path, suffix] of [
    ['ws', '::1', '', '[::1]:1883/mqtt'],
    ['wss', '[::1]', '/', '[::1]:1883/'],
    ['ws', 'localhost', 'tenant/mqtt?x=1', 'localhost:1883/tenant/mqtt?x=1'],
    ['mqtt', '::1', '/ignored', '[::1]:1883'],
    ['mqtts', '[2001:db8::1]', '', '[2001:db8::1]:1883'],
  ]) {
    const f = createFixture(); const pending = f.coordinator.connect({ id: 'endpoint', protocol, host, path, port: 1883 });
    await new Promise(resolve => setImmediate(resolve));
    f.clients[0]?.emit('connect'); await pending;
    assert.equal(f.connectCalls[0]?.[0], `${protocol}://${suffix}`);
    await f.coordinator.disconnectAll();
  }
});


test('real loopback WebSocket MQTT connects using default, root and custom query paths', { timeout: 20000 }, async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { WebSocketServer } = require('ws'); const mqtt = require('mqtt');
  const server = createServer(); const paths = []; const identities = [];
  const ws = new WebSocketServer({ server });
  ws.on('connection', (socket, request) => {
    paths.push(request.url);
    // MQTT.js may split a single packet across multiple WebSocket messages.
    const parser = createRequire(require.resolve('mqtt'))('mqtt-packet').parser();
    parser.on('error', () => socket.terminate());
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') {
        identities.push(packet.clientId); socket.send(Buffer.from([0x20, 2, 0, 0]));
      } else if (packet.cmd === 'pingreq') socket.send(Buffer.from([0xd0, 0]));
      else if (packet.cmd === 'disconnect') socket.close();
    });
    socket.on('message', data => parser.parse(data));
  });
  server.listen(0, '::1'); await once(server, 'listening');
  const coordinator = createMqttCoordinator({ mqtt, send() {} });
  t.after(async () => {
    await coordinator.disconnectAll(); for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve));
  });
  for (const [host, path] of [['::1', ''], ['[::1]', '/'], ['::1', 'tenant/mqtt?x=1&clientId=query-id']]) {
    const result = await coordinator.connect({ id: 'ws-path', host, port: server.address().port, protocol: 'ws', path, clientId: 'configured-id', autoReconnect: false });
    assert.equal(result.ok, true, JSON.stringify(result)); await coordinator.disconnect('ws-path');
  }
  assert.deepEqual(identities, ['configured-id', 'configured-id', 'configured-id']);
  assert.deepEqual(paths, ['/mqtt', '/', '/tenant/mqtt?x=1&clientId=query-id']);
});

test('real IPv6 loopback broker accepts bare and bracketed hosts through form and Electron', { timeout: 20000 }, async t => {
  const { createServer } = await import('node:net'); const { once } = await import('node:events');
  const { Aedes } = await import('aedes');
  const { createNewConnectionDraft, validateConnectionDraft } = await import('../../../packages/domain/src/connectionModel.js');
  const broker = await Aedes.createBroker(); const server = createServer(broker.handle);
  const coordinator = createMqttCoordinator({ mqtt: require('mqtt'), send() {} });
  t.after(async () => { await coordinator.disconnectAll(); await new Promise(resolve => broker.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '::1'); await once(server, 'listening');
  for (const host of ['::1', '[::1]']) {
    const input = { ...createNewConnectionDraft(), id: 'ipv6', name: 'IPv6', host, port: server.address().port, autoReconnect: false };
    assert.deepEqual(validateConnectionDraft(input), {});
    assert.equal((await coordinator.connect(input)).ok, true); await coordinator.disconnect('ipv6');
  }
});

test('invalid broker hosts and WebSocket paths do not replace an active native connection', async () => {
  const f = createFixture();
  const input = { id: 'protected', host: 'localhost', protocol: 'ws', port: 1883 };
  const pending = f.coordinator.connect(input); f.clients[0].emit('connect'); await pending;
  for (const invalid of [{ host: '::1]' }, { host: 'user@broker' }, { path: '/mqtt#fragment' }, { path: '/mqtt\n' }]) {
    assert.equal((await f.coordinator.connect({ ...input, ...invalid })).ok, false);
    assert.equal(f.connectCalls.length, 1);
    assert.equal(f.clients[0].endCalls.length, 0);
  }
  await f.coordinator.disconnectAll();
});
