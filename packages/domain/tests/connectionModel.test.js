import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPersistedMessageCounts,
  createConnectionFromDraft,
  createEditConnectionDraft,
  createNewConnectionDraft,
  incrementConnectionMessageCount,
  normalizeRuntimeConnection,
  normalizeSubscription,
  toDbConnection,
  validateConnectionDraft
} from '../src/connectionModel.js';

test('normalizeRuntimeConnection adds UI runtime fields without changing persisted data shape', () => {
  const conn = normalizeRuntimeConnection({ id: 'c1', protocol: 'mqtt', host: 'localhost' });

  assert.equal(conn.status, 'disconnected');
  assert.equal(conn.protocol, 'mqtt://');
  assert.equal(conn.messagesIn, 0);
  assert.equal(conn.messagesOut, 0);
});

test('normalizeSubscription maps database subscription fields to renderer fields', () => {
  const sub = normalizeSubscription({ id: 's1', connection_id: 'c1', topic: '#', color: '#2563eb', format: 'hex' });

  assert.equal(sub.connId, 'c1');
  assert.equal(sub.messageCount, 0);
  assert.equal(sub.color, '#2563eb');
  assert.equal(sub.format, 'hex');
  assert.equal(sub.status, 'inactive');
});

test('toDbConnection keeps database persistence field names centralized', () => {
  const dbConn = toDbConnection({ id: 'c1', name: 'Local', host: 'localhost', port: 1883, protocol: 'mqtt://', clientId: 'client-a' });

  assert.equal(dbConn.protocol, 'mqtt');
  assert.equal(dbConn.client_id, 'client-a');
  assert.equal(dbConn.keepalive, 60);
});

test('createEditConnectionDraft restores protocol suffix for modal editing', () => {
  const draft = createEditConnectionDraft({ protocol: 'mqtt', ssl: 0, name: 'A', host: 'localhost', port: 1883 });

  assert.equal(draft.protocol, 'mqtt://');
});

test('editing a saved connection displays its native client ID', () => {
  const draft = createEditConnectionDraft({ name: 'Local', host: 'localhost', protocol: 'mqtt', port: 1883,
    client_id: 'persistent-device-session' });
  assert.equal(draft.clientId, 'persistent-device-session');
});

test('clearing an edited client ID persists automatic identity instead of restoring the old ID', () => {
  const saved = toDbConnection({ id: 'local', client_id: 'old-identity', clientId: '' });
  assert.equal(saved.client_id, '');
  assert.equal(toDbConnection({ id: 'local', client_id: 'old-identity' }).client_id, 'old-identity');
});

test('validateConnectionDraft reports only requested field errors', () => {
  const errors = validateConnectionDraft({ name: '', host: '', port: 0, keepalive: 1 }, 'host');

  assert.deepEqual(errors, { host: '主机地址不能为空' });
});

test('connection drafts reject fractional and blank port/keepalive values before persistence', () => {
  const valid = { name: 'Local', host: 'localhost', port: 1883, keepalive: 60 };
  for (const field of ['port', 'keepalive']) {
    for (const value of ['', ' ', 1.5, 1883.5, NaN, null, false, []]) {
      assert.ok(validateConnectionDraft({ ...valid, [field]: value })[field], `${field}=${String(value)}`);
    }
  }
  assert.deepEqual(validateConnectionDraft({ ...valid, port: '1883', keepalive: '60' }), {});
});

test('connection message counters initialize from history totals and accumulate by direction', () => {
  const connections = [
    { id: 'a', messagesIn: 0, messagesOut: 0 },
    { id: 'b', messagesIn: 0, messagesOut: 0 }
  ];

  applyPersistedMessageCounts(connections, [
    { connection_id: 'a', messages_in: 12, messages_out: 3 },
    { connection_id: 'b', messages_in: 4, messages_out: 2 }
  ]);
  incrementConnectionMessageCount(connections, 'a', 'in');
  incrementConnectionMessageCount(connections, 'a', 'out');

  assert.deepEqual(connections[0], { id: 'a', messagesIn: 13, messagesOut: 4 });
  assert.deepEqual(connections[1], { id: 'b', messagesIn: 4, messagesOut: 2 });
});

test('new connection defaults preserve the configured clean session through persistence', () => {
  for (const [setting, expected] of [[false, 0], [true, 1]]) {
    const draft = createNewConnectionDraft(120, setting);
    const connection = createConnectionFromDraft(draft, 0);
    assert.equal(connection.keepalive, 120);
    assert.equal(connection.cleanSession, expected);
    assert.equal(toDbConnection(connection).clean_session, expected);
  }
  assert.equal(toDbConnection(createConnectionFromDraft(createNewConnectionDraft(), 0)).clean_session, 1);
});

test('edited connections keep their own clean session regardless of new connection defaults', () => {
  for (const clean_session of [0, 1]) {
    const original = { id: 'existing', name: 'Saved', clean_session };
    const draft = createEditConnectionDraft(original);
    assert.equal(toDbConnection({ ...original, ...draft }).clean_session, clean_session);
  }
});

test('clean session boolean and numeric inputs persist as SQLite compatible integer values', () => {
  for (const [value, expected] of [[false, 0], [true, 1], [0, 0], [1, 1]]) {
    assert.equal(toDbConnection({ cleanSession: value }).clean_session, expected);
    assert.equal(toDbConnection({ clean_session: value }).clean_session, expected);
  }
});


test('connection forms accept IPv6 and reject hosts containing URL syntax or malformed IPv6', () => {
  const draft = { ...createNewConnectionDraft(), name: 'IPv6' };
  for (const host of ['::1', '[::1]', '2001:db8::42', '[::ffff:192.0.2.1]', 'broker.example.com', '127.0.0.1'])
    assert.equal(validateConnectionDraft({ ...draft, host }).host, undefined, host);
  for (const host of [':::1', '[::1', '::1]', '[broker]', 'host:1883', 'user@host', 'host/path', 'host\\path', ' host '])
    assert.ok(validateConnectionDraft({ ...draft, host }).host, host);
});

test('WebSocket path validation allows root and queries and rejects fragments and controls', () => {
  const draft = { ...createNewConnectionDraft(), name: 'WS', protocol: 'ws://' };
  for (const path of ['', '/', '/mqtt', 'tenant/mqtt?token=one%20two'])
    assert.equal(validateConnectionDraft({ ...draft, path }).path, undefined, path);
  for (const path of ['/mqtt#fragment', '/mqtt\n', '/mqtt path', '/mqtt\\path', 'x'.repeat(2049)])
    assert.ok(validateConnectionDraft({ ...draft, path }).path, path);
});
