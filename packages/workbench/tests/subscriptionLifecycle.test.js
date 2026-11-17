import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionLifecycle } from '../src/workspace/subscriptionLifecycle.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const row = (id = 'new') => ({ id, connId: 'c', topic: `sensor/${id}`, qos: 1, status: 'active', color: '#569cd6', format: 'text' });
function fixture(saved = []) {
  const connection = { id: 'c', status: 'connected' };
  let subscriptions = saved;
  const calls = [];
  const persisted = new Map();
  const mqtt = {
    subscribe: async (...args) => { calls.push(['subscribe', ...args]); return { ok: true }; },
    unsubscribe: async (...args) => { calls.push(['unsubscribe', ...args]); return { ok: true }; },
  };
  const db = {
    addSubscription: async value => { persisted.set(value.id, value); return { ok: true }; },
    removeSubscription: async id => { persisted.delete(id); return { ok: true }; },
    saveSetting: async () => ({ ok: true }),
  };
  const lifecycle = createSubscriptionLifecycle({ mqtt, db,
    workspace: { getConnection: () => connection, getSubscriptions: () => subscriptions,
      replaceSubscriptions: value => { subscriptions = value; }, hasConnection: () => true, isClosing: () => false },
    operations: { run: fn => fn(0), isCurrent: () => true }, addLog: () => {},
  });
  return { connection, mqtt, db, calls, persisted, lifecycle, get subscriptions() { return subscriptions; } };
}

for (const boundary of ['ack', 'persistence']) {
  test(`disconnect during new subscription ${boundary} retains durable intent without live status`, async t => {
    const h = fixture(); t.after(h.lifecycle.clearPendingTimers);
    const gate = Promise.withResolvers();
    if (boundary === 'ack') h.mqtt.subscribe = () => gate.promise;
    else {
      const add = h.db.addSubscription;
      h.db.addSubscription = async value => { await gate.promise; return add(value); };
    }
    const pending = h.lifecycle.addSubscription(row(), 0);
    await tick();
    h.lifecycle.updateConnectionStatus('c', 'disconnected');
    gate.resolve({ ok: true });
    assert.equal(await pending, true);
    assert.equal(h.subscriptions[0].status, 'inactive');
    assert(h.persisted.has('new'));
    assert.equal(h.calls.some(call => call[0] === 'unsubscribe'), false);
  });
}

test('automatic loss clears active and pending saved subscriptions immediately', async t => {
  const h = fixture([row()]); t.after(h.lifecycle.clearPendingTimers);
  const ack = Promise.withResolvers(); h.mqtt.subscribe = () => ack.promise;
  const restore = h.lifecycle.restoreConnectionSubscriptions('c'); await tick();
  assert.equal(h.subscriptions[0].status, 'pending');
  h.lifecycle.updateConnectionStatus('c', 'reconnecting');
  assert.equal(h.subscriptions[0].status, 'inactive');
  ack.resolve({ ok: true }); await restore;
  assert.equal(h.subscriptions[0].status, 'inactive');
});

test('reconnection restores a late saved row only after the new session ACK', async t => {
  const h = fixture(); t.after(h.lifecycle.clearPendingTimers);
  const saved = Promise.withResolvers(), ack = Promise.withResolvers();
  const add = h.db.addSubscription;
  h.db.addSubscription = async value => { await saved.promise; return add(value); };
  const pending = h.lifecycle.addSubscription(row(), 0); await tick();
  h.lifecycle.updateConnectionStatus('c', 'reconnecting');
  h.lifecycle.updateConnectionStatus('c', 'connected');
  h.mqtt.subscribe = () => ack.promise;
  const restored = h.lifecycle.restoreConnectionSubscriptions('c');
  saved.resolve(); await pending; await tick();
  assert.equal(h.subscriptions[0].status, 'pending');
  ack.resolve({ ok: true }); assert.equal(await restored, true);
  assert.equal(h.subscriptions[0].status, 'active');
});

test('new-subscription persistence failure cannot unsubscribe a replacement session', async t => {
  const h = fixture(); t.after(h.lifecycle.clearPendingTimers);
  const saved = Promise.withResolvers(); h.db.addSubscription = () => saved.promise;
  const pending = h.lifecycle.addSubscription(row(), 0); await tick();
  h.lifecycle.beginConnectionRequest('c');
  h.lifecycle.updateConnectionStatus('c', 'disconnected'); h.lifecycle.updateConnectionStatus('c', 'connected');
  saved.reject(Error('disk failure')); await assert.rejects(pending, /disk failure/);
  assert.equal(h.calls.some(call => call[0] === 'unsubscribe'), false);
  assert.equal(h.subscriptions.length, 0);
  assert.equal(await h.lifecycle.restoreConnectionSubscriptions('c'), true);
  assert.deepEqual(h.calls.filter(call => call[0] === 'unsubscribe'), [['unsubscribe', 'c', 'sensor/new']]);
});

test('copy persistence completing after disconnect saves an inactive row', async t => {
  const h = fixture(); t.after(h.lifecycle.clearPendingTimers);
  const saved = Promise.withResolvers(); const add = h.db.addSubscription;
  h.db.addSubscription = async value => { await saved.promise; return add(value); };
  const pending = h.lifecycle.copySubscription({ source: row(), copied: row('copy'), target: h.connection, targetConnected: true }, 0);
  await tick(); h.lifecycle.updateConnectionStatus('c', 'disconnected'); saved.resolve();
  assert.equal(await pending, true); assert.equal(h.subscriptions[0].status, 'inactive');
  assert(h.persisted.has('copy'));
});

test('queued copy evaluates target connection when execution starts', async t => {
  const h = fixture(); t.after(h.lifecycle.clearPendingTimers);
  const gate = Promise.withResolvers(); let count = 0; const add = h.db.addSubscription;
  h.db.addSubscription = async value => { if (++count === 1) await gate.promise; return add(value); };
  const first = h.lifecycle.addSubscription(row(), 0); await tick();
  h.lifecycle.updateConnectionStatus('c', 'disconnected');
  const copied = h.lifecycle.copySubscription({ source: row(), copied: row('copy'), target: h.connection, targetConnected: false }, 0);
  h.lifecycle.updateConnectionStatus('c', 'connected'); gate.resolve();
  await first; assert.equal(await copied, true);
  assert(h.calls.some(call => call[0] === 'subscribe' && call[2] === 'sensor/copy'));
  assert.equal(h.subscriptions.find(item => item.id === 'copy').status, 'active');
});

test('failed deletion cannot restore an old filter into a replacement session', async t => {
  const h = fixture([row()]); t.after(h.lifecycle.clearPendingTimers);
  const removed = Promise.withResolvers(); h.db.removeSubscription = () => removed.promise;
  const pending = h.lifecycle.removeSubscription(h.subscriptions[0], 0); await tick();
  h.lifecycle.updateConnectionStatus('c', 'reconnecting'); h.lifecycle.updateConnectionStatus('c', 'connected');
  removed.reject(Error('delete failed')); await assert.rejects(pending, /delete failed/);
  assert.equal(h.calls.some(call => call[0] === 'subscribe'), false);
  assert.equal(h.subscriptions[0].status, 'inactive');
});

test('disconnect during deletion compensation cannot reactivate the retained row', async t => {
  const h = fixture([row()]); t.after(h.lifecycle.clearPendingTimers);
  h.db.removeSubscription = async () => { throw Error('delete failed'); };
  const ack = Promise.withResolvers(); h.mqtt.subscribe = () => ack.promise;
  const pending = h.lifecycle.removeSubscription(h.subscriptions[0], 0); await tick();
  h.lifecycle.updateConnectionStatus('c', 'disconnected'); ack.resolve({ ok: true });
  await assert.rejects(pending, /delete failed/);
  assert.equal(h.subscriptions[0].status, 'inactive');
});

test('copy failure cannot roll back a replacement session', async t => {
  const h = fixture(); t.after(h.lifecycle.clearPendingTimers);
  const saved = Promise.withResolvers(); h.db.addSubscription = () => saved.promise;
  const pending = h.lifecycle.copySubscription({ source: row(), copied: row('copy'), target: h.connection, targetConnected: true }, 0);
  await tick(); h.lifecycle.updateConnectionStatus('c', 'reconnecting'); h.lifecycle.updateConnectionStatus('c', 'connected');
  saved.reject(Error('copy failed')); await assert.rejects(pending, /copy failed/);
  assert.equal(h.calls.some(call => call[0] === 'unsubscribe'), false);
});
