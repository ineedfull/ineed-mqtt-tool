import assert from 'node:assert/strict';
import test from 'node:test';

import { publishOnce } from '../src/workspace/publishWorkflow.js';

test('publishOnce rejects invalid topic names before invoking either runtime', async () => {
  let calls = 0;
  const mqtt = { publish() { calls++; return { ok: true }; } };
  for (const topic of ['bad/#', 'bad/+', 'bad\u0000topic', 'bad\u0001topic', 'a'.repeat(65_536), '中'.repeat(21_846)]) {
    const result = await publishOnce({ mqtt, connection: { id: 'c', status: 'connected' }, topic, payload: 'test', qos: 0 });
    assert.equal(result.ok, false, `invalid topic ${topic.slice(0, 20)} must be rejected`);
    assert.ok(result.error);
  }
  assert.equal(calls, 0);
});

test('publishOnce awaits broker success with the exact normalized arguments', async () => {
  const calls = [];
  const brokerResult = { ok: true, packetId: 7 };
  const payload = new Uint8Array([0x6f, 0x6b]);
  const mqtt = {
    async publish(...args) {
      calls.push(args);
      return brokerResult;
    },
  };

  const result = await publishOnce({
    mqtt,
    connection: { id: 'conn-1', status: 'connected' },
    topic: '  device/relay  ',
    payload,
    qos: 2,
    retain: true,
  });

  assert.deepEqual(result, {
    ok: true,
    result: brokerResult,
    topic: 'device/relay',
  });
  assert.deepEqual(calls, [['conn-1', 'device/relay', payload, 2, true]]);
  assert.equal(calls[0][2], payload);
});

test('publishOnce rejects missing or disconnected connections without publishing', async () => {
  let calls = 0;
  const mqtt = { publish() { calls += 1; } };

  for (const connection of [
    undefined,
    null,
    {},
    { status: 'connected' },
    { id: 'c', status: 'disconnected' },
  ]) {
    assert.deepEqual(await publishOnce({ mqtt, connection, topic: 'topic' }), {
      ok: false,
      error: '请先连接 MQTT Broker',
    });
  }
  assert.equal(calls, 0);
});

test('publishOnce rejects blank topics and missing publish capability without calls', async () => {
  let calls = 0;
  const connection = { id: 'c', status: 'connected' };
  const mqtt = { publish() { calls += 1; } };

  assert.deepEqual(await publishOnce({ mqtt, connection, topic: '  ' }), {
    ok: false,
    error: '请输入发布 Topic',
  });
  assert.deepEqual(await publishOnce({ mqtt: {}, connection, topic: 'topic' }), {
    ok: false,
    error: 'MQTT 发布能力不可用',
  });
  assert.equal(calls, 0);
});

test('publishOnce converts thrown and rejected broker errors into stable failures', async () => {
  const connection = { id: 'c', status: 'connected' };

  assert.deepEqual(await publishOnce({
    mqtt: { publish() { throw new Error('sync failure'); } },
    connection,
    topic: 'topic',
  }), { ok: false, error: 'sync failure' });
  assert.deepEqual(await publishOnce({
    mqtt: { publish() { return Promise.reject('async failure'); } },
    connection,
    topic: 'topic',
  }), { ok: false, error: 'async failure' });
});

test('publishOnce accepts only explicit broker success', async () => {
  const connection = { id: 'c', status: 'connected' };

  assert.deepEqual(await publishOnce({
    mqtt: { publish: async () => ({ ok: false, error: 'broker refused' }) },
    connection,
    topic: 'topic',
  }), { ok: false, error: 'broker refused' });
  assert.deepEqual(await publishOnce({
    mqtt: { publish: async () => ({ ok: false }) },
    connection,
    topic: 'topic',
  }), { ok: false, error: '发布失败' });
  assert.deepEqual(await publishOnce({
    mqtt: { publish: async () => undefined },
    connection,
    topic: 'topic',
  }), { ok: false, error: '发布失败' });
});
