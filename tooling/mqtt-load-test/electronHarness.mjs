import { createRequire } from 'node:module';

import mqtt from 'mqtt';
import { normalizeMessageBatch, normalizeMqttStatus } from '@ineed-mqtt-tool/mqtt-contract';

const require = createRequire(import.meta.url);
const { createMqttCoordinator } = require('../../apps/electron/electron/main.cjs');

function payloadHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export function createElectronHarness({ onMessageBatch = () => {} } = {}) {
  const events = [];
  const waiters = new Set();
  const operations = new Set();
  const abortTasks = new Set();
  const trackedConnections = new Set();
  let closed = false;
  const deliver = event => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  };
  const coordinator = createMqttCoordinator({
    mqtt,
    send(channel, input) {
      if (channel === 'mqtt:messages') {
        const messages = normalizeMessageBatch(input).map(message => ({
          type: 'message',
          ...message,
          payloadHex: payloadHex(message.payload),
          byteLength: message.payload.byteLength,
        }));
        onMessageBatch(messages);
        for (const message of messages) deliver(message);
      } else if (channel === 'mqtt:status') {
        deliver({ type: 'status', ...normalizeMqttStatus(input) });
      }
    },
  });

  function trackAbort(connId, operation) {
    trackedConnections.delete(connId);
    const task = Promise.resolve(coordinator.disconnect(connId, { force: true }))
      .then(() => Promise.resolve())
      .then(() => coordinator.disconnect(connId, { force: true }))
      .finally(() => abortTasks.delete(task));
    abortTasks.add(task);
    operation.then(
      () => coordinator.disconnect(connId, { force: true }),
      () => coordinator.disconnect(connId, { force: true }),
    ).catch(() => undefined);
    return task;
  }

  function invoke(name, args, signal) {
    const connId = name === 'connect' ? args[0]?.id : args[0];
    if (name === 'connect' && connId) trackedConnections.add(connId);
    const operation = Promise.resolve().then(() => coordinator[name](...args));
    const tracked = { operation, connId, abort: null };
    operations.add(tracked);
    const finish = () => {
      signal?.removeEventListener('abort', tracked.abort);
      operations.delete(tracked);
    };
    operation.then(result => {
      if (name === 'connect' && !result?.ok) trackedConnections.delete(connId);
      if (name === 'disconnect' && result?.ok) trackedConnections.delete(connId);
    }, () => {
      if (name === 'connect') trackedConnections.delete(connId);
    }).finally(finish);
    if (!signal) return operation;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', tracked.abort);
        callback(value);
      };
      tracked.abort = () => {
        if (connId) void trackAbort(connId, operation);
        settle(reject, signal.reason);
      };
      if (signal.aborted) tracked.abort();
      else signal.addEventListener('abort', tracked.abort, { once: true });
      operation.then(value => settle(resolve, value), error => settle(reject, error));
    });
  }

  function waitFor(predicate, timeoutMs = 4_000, signal) {
    const existing = events.findLast(predicate);
    if (existing) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      const abort = () => {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        reject(signal.reason);
      };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        signal?.removeEventListener('abort', abort);
        reject(new Error(`Electron MQTT event wait exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      waiter.resolve = value => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      waiters.add(waiter);
    });
  }

  return Object.freeze({
    runtime: 'electron',
    events,
    command(name, ...args) {
      const options = args.at(-1)?.signal ? args.pop() : {};
      if (closed) return Promise.reject(new Error('Electron harness is closed'));
      if (typeof coordinator[name] !== 'function') return Promise.resolve({ ok: false, error: `unknown command: ${name}` });
      return invoke(name, args, options.signal);
    },
    waitMessage(predicate, timeoutMs, signal) {
      return waitFor(event => event.type === 'message' && predicate(event), timeoutMs, signal);
    },
    waitStatus(predicate, timeoutMs, signal) {
      return waitFor(event => event.type === 'status' && predicate(event), timeoutMs, signal);
    },
    async expectNoMessage(predicate, durationMs = 500, signal) {
      const start = events.length;
      await new Promise((resolve, reject) => {
        const finish = (operation, value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          operation(value);
        };
        const timer = setTimeout(() => finish(resolve), durationMs);
        const abort = () => finish(reject, signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
      });
      if (events.slice(start).some(event => event.type === 'message' && predicate(event))) {
        throw new Error('unexpected MQTT message after unsubscribe');
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject?.(new Error('Electron harness closed'));
      }
      waiters.clear();
      coordinator.dispose();
      await coordinator.disconnectAll({ force: true });
      await Promise.resolve();
      await coordinator.disconnectAll({ force: true });
      await Promise.allSettled([...abortTasks]);
      trackedConnections.clear();
    },
    get diagnostics() {
      return {
        trackedConnections: coordinator.size + trackedConnections.size,
        pendingOperations: operations.size + abortTasks.size,
        pendingWaiters: waiters.size,
      };
    },
    get isClosed() { return closed; },
    get connectionCount() { return coordinator.size + trackedConnections.size; },
  });
}
