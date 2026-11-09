import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { CLOSE_ACK_TIMEOUT_MS, installCloseHandshake } = require('../electron/main.cjs');

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    size() { return timers.size; },
  };
}

function createFixture() {
  const ipcMain = new EventEmitter();
  const window = new EventEmitter();
  const sender = { sendCalls: [], send(channel, payload) { this.sendCalls.push([channel, payload]); } };
  window.webContents = sender;
  window.isDestroyed = () => false;
  const clock = createClock();
  const finalized = [];
  const controller = installCloseHandshake({
    window,
    ipcMain,
    createRequestId: () => 'close-request-1',
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    finalize: result => finalized.push(result),
  });
  return { clock, controller, finalized, ipcMain, sender, window };
}

test('close handshake waits through the renderer nine-second teardown budget', () => {
  assert.equal(CLOSE_ACK_TIMEOUT_MS, 15_000);
  const { clock, finalized, ipcMain, sender, window } = createFixture();
  let prevented = 0;

  window.emit('close', { preventDefault() { prevented += 1; } });
  clock.advance(9_000);
  assert.equal(prevented, 1);
  assert.equal(finalized.length, 0);

  ipcMain.emit('lifecycle:before-close-ack', { sender }, { requestId: 'close-request-1', ok: true });
  assert.deepEqual(finalized, [{ requestId: 'close-request-1', ok: true, timedOut: false }]);
  assert.equal(clock.size(), 0);
});

test('close handshake ignores spoofed, unrelated, malformed, and duplicate acknowledgements', () => {
  const { finalized, ipcMain, sender, window } = createFixture();
  window.emit('close', { preventDefault() {} });

  ipcMain.emit('lifecycle:before-close-ack', { sender: {} }, { requestId: 'close-request-1', ok: true });
  ipcMain.emit('lifecycle:before-close-ack', { sender }, { requestId: 'other', ok: true });
  ipcMain.emit('lifecycle:before-close-ack', { sender }, { requestId: 'close-request-1', ok: 'true' });
  assert.doesNotThrow(() => ipcMain.emit('lifecycle:before-close-ack', { sender }, {
    get requestId() { throw new Error('hostile getter'); },
  }));
  assert.deepEqual(finalized, []);

  ipcMain.emit('lifecycle:before-close-ack', { sender }, { requestId: 'close-request-1', ok: false });
  ipcMain.emit('lifecycle:before-close-ack', { sender }, { requestId: 'close-request-1', ok: true });
  assert.equal(finalized.length, 1);
  assert.equal(ipcMain.listenerCount('lifecycle:before-close-ack'), 0);
});

test('close handshake controls reentry and falls back only at fifteen seconds', () => {
  const { clock, finalized, sender, window } = createFixture();
  let prevented = 0;
  window.emit('close', { preventDefault() { prevented += 1; } });
  window.emit('close', { preventDefault() { prevented += 1; } });

  assert.equal(prevented, 2);
  assert.match(sender.sendCalls[0][1].requestId, /\S/);
  clock.advance(14_999);
  assert.deepEqual(finalized, []);
  clock.advance(1);
  assert.deepEqual(finalized, [{ requestId: 'close-request-1', ok: false, timedOut: true }]);
});

test('close handshake keeps reentry controlled until asynchronous finalization settles', async () => {
  const ipcMain = new EventEmitter();
  const window = new EventEmitter();
  const sender = { send() {} };
  window.webContents = sender;
  window.isDestroyed = () => false;
  let releaseFinalize;
  const finalizing = new Promise(resolvePromise => { releaseFinalize = resolvePromise; });
  installCloseHandshake({
    window,
    ipcMain,
    createRequestId: () => 'close-request-finalizing',
    setTimer: () => 1,
    clearTimer: () => {},
    finalize: () => finalizing,
  });
  let prevented = 0;
  const closeEvent = { preventDefault() { prevented += 1; } };
  window.emit('close', closeEvent);
  ipcMain.emit('lifecycle:before-close-ack', { sender }, {
    requestId: 'close-request-finalizing', ok: true,
  });
  window.emit('close', closeEvent);

  assert.equal(prevented, 2);
  assert.equal(window.listenerCount('close'), 1);
  releaseFinalize();
  await finalizing;
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(window.listenerCount('close'), 0);
});

test('disposing close handshake removes listeners and timers without finalizing', () => {
  const { clock, controller, finalized, ipcMain, window } = createFixture();
  window.emit('close', { preventDefault() {} });
  controller.dispose();

  assert.equal(clock.size(), 0);
  assert.equal(window.listenerCount('close'), 0);
  assert.equal(ipcMain.listenerCount('lifecycle:before-close-ack'), 0);
  assert.deepEqual(finalized, []);
});
