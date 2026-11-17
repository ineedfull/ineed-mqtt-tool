'use strict';

// Owns close acknowledgement and bounded shutdown; bootstrap registers app listeners once.
const { randomUUID } = require('node:crypto');
const { IPC_CHANNELS } = require('./ipcContract.cjs');
const { errorMessage, nonblankString } = require('./runtimeValidation.cjs');

const CLOSE_ACK_TIMEOUT_MS = 15_000;

function installCloseHandshake({
  window,
  ipcMain,
  timeoutMs = CLOSE_ACK_TIMEOUT_MS,
  createRequestId = randomUUID,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
  finalize,
  isBlocked = () => false,
} = {}) {
  if (!window?.webContents || typeof ipcMain?.on !== 'function') {
    throw new TypeError('window and ipcMain are required');
  }
  if (typeof finalize !== 'function') throw new TypeError('finalize must be a function');
  let started = false;
  let disposed = false;
  let settled = false;
  let timer = null;
  let requestId = null;

  function removeAckListener() {
    ipcMain.removeListener(IPC_CHANNELS.lifecycleBeforeCloseAck, onAck);
  }

  function cleanupAck() {
    removeAckListener();
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function cleanup() {
    cleanupAck();
    window.removeListener?.('close', onClose);
  }

  function settle(ok, timedOut) {
    if (settled || disposed) return;
    settled = true;
    cleanupAck();
    Promise.resolve(finalize({ requestId, ok, timedOut })).catch(error => {
      console.error('[Electron] close finalization failed:', errorMessage(error));
    }).finally(() => {
      if (!disposed) {
        disposed = true;
        cleanup();
      }
    });
  }

  function onAck(event, payload) {
    let acknowledgedRequestId;
    let acknowledgedOk;
    try {
      acknowledgedRequestId = payload?.requestId;
      acknowledgedOk = payload?.ok;
    } catch {
      return;
    }
    if (
      !started
      || settled
      || event?.sender !== window.webContents
      || acknowledgedRequestId !== requestId
      || typeof acknowledgedOk !== 'boolean'
    ) return;
    settle(acknowledgedOk, false);
  }

  function onClose(event) {
    if (disposed) return;
    event.preventDefault();
    if (isBlocked()) return;
    if (started) return;
    started = true;
    requestId = nonblankString(createRequestId());
    if (requestId === null) requestId = randomUUID();
    ipcMain.on(IPC_CHANNELS.lifecycleBeforeCloseAck, onAck);
    timer = setTimer(() => settle(false, true), timeoutMs);
    window.webContents.send(IPC_CHANNELS.lifecycleBeforeClose, { requestId });
  }

  window.on('close', onClose);
  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanup();
    },
  });
}

function createShutdownController({
  mqttCoordinator,
  db,
  removeHandlers,
  getCloseController,
  app,
  onError = () => {},
} = {}) {
  let inFlight = null;
  let running = false;

  function shutdown(window) {
    if (inFlight !== null) return inFlight;
    running = true;
    inFlight = (async () => {
      const errors = [];
      async function attempt(phase, operation) {
        try {
          await operation();
        } catch (error) {
          errors.push({ phase, error });
          try { onError(phase, error); } catch { /* Keep shutdown reporting contained. */ }
        }
      }
      try {
        await attempt('disconnect', () => mqttCoordinator.disconnectAll());
        await attempt('flush', () => mqttCoordinator.flush());
        await attempt('database', () => db.closeDatabase());
      } finally {
        await attempt('mqtt-dispose', () => mqttCoordinator.dispose());
        await attempt('handlers', () => removeHandlers());
        await attempt('close-controller', () => getCloseController()?.dispose());
        await attempt('destroy', () => {
          if (window && !window.isDestroyed()) window.destroy();
        });
        await attempt('quit', () => app.quit());
        running = false;
      }
      return { ok: errors.length === 0, errors };
    })();
    return inFlight;
  }

  return Object.freeze({
    shutdown,
    get running() { return running; },
    get started() { return inFlight !== null; },
  });
}

function shouldCreateMainWindow({ windowManager, shutdownController }) {
  if (shutdownController.started) return false;
  const mainWindow = windowManager.getMainWindow();
  return !mainWindow || mainWindow.isDestroyed();
}

module.exports = {
  CLOSE_ACK_TIMEOUT_MS,
  installCloseHandshake,
  createShutdownController,
  shouldCreateMainWindow,
};
