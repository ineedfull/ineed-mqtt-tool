import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { requestUpdatePreparation } = require('../electron/updatePreparation.cjs');

test('update preparation accepts only the main frame matching the live request', async () => {
  const ipcMain = new EventEmitter();
  let request;
  const webContents = { mainFrame: {}, send: (_channel, value) => { request = value; } };
  const window = { webContents, isDestroyed: () => false };
  let done = false;
  const pending = requestUpdatePreparation({ window, ipcMain }).then(() => { done = true; });
  ipcMain.emit('lifecycle:before-close-ack', { sender: {}, senderFrame: webContents.mainFrame }, { requestId: request.requestId, ok: true });
  ipcMain.emit('lifecycle:before-close-ack', { sender: webContents, senderFrame: {} }, { requestId: request.requestId, ok: true });
  ipcMain.emit('lifecycle:before-close-ack', { sender: webContents, senderFrame: webContents.mainFrame }, { requestId: 'stale', ok: true });
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(request.purpose, 'update');
  ipcMain.emit('lifecycle:before-close-ack', { sender: webContents, senderFrame: webContents.mainFrame }, { requestId: request.requestId, ok: true });
  await pending;
  assert.equal(ipcMain.listenerCount('lifecycle:before-close-ack'), 0);
});

test('rejected or missing save acknowledgement aborts installation and removes listeners', async () => {
  for (const respond of [true, false]) {
    const ipcMain = new EventEmitter();
    const webContents = { mainFrame: {}, send: (_channel, request) => {
      if (respond) queueMicrotask(() => ipcMain.emit('lifecycle:before-close-ack', { sender: webContents, senderFrame: webContents.mainFrame },
        { requestId: request.requestId, ok: false, error: { message: 'disk full' } }));
    } };
    await assert.rejects(requestUpdatePreparation({ ipcMain, window: { webContents, isDestroyed: () => false }, timeoutMs: 5 }), /disk full|保存确认超时/);
    assert.equal(ipcMain.listenerCount('lifecycle:before-close-ack'), 0);
  }
});
