'use strict';

// Registers authorized invokes and payload validation; returns one handler disposer.
const {
  IPC_CHANNELS,
  DB_HANDLERS,
  BATCH_CHANNELS,
  IPC_MAX_BATCH_ITEMS,
  IPC_MAX_ITEM_BYTES,
  IPC_MAX_TOTAL_BYTES,
  IPC_CLIPBOARD_MAX_BYTES,
} = require('./ipcContract.cjs');
const { isSafeExternalUrl, checkForUpdates } = require('./updateCheck.cjs');

function ipcValueByteLength(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  if (
    Array.isArray(value)
    && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) return value.length;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('unsupported value');
    return Buffer.byteLength(serialized, 'utf8');
  } catch {
    throw new TypeError('IPC payload must be serializable');
  }
}

function validateIpcPayload(channel, args, {
  maxBatchItems = IPC_MAX_BATCH_ITEMS,
  maxItemBytes = IPC_MAX_ITEM_BYTES,
  maxTotalBytes = IPC_MAX_TOTAL_BYTES,
} = {}) {
  if (!Array.isArray(args)) throw new TypeError('IPC arguments must be an array');
  const values = [];
  if (BATCH_CHANNELS.has(channel) && Array.isArray(args[0])) {
    if (args[0].length > maxBatchItems) throw new RangeError('IPC batch item limit exceeded');
    values.push(...args[0], ...args.slice(1));
  } else {
    values.push(...args);
  }
  let totalBytes = 0;
  for (const value of values) {
    const bytes = ipcValueByteLength(value);
    if (bytes > maxItemBytes) throw new RangeError('IPC payload item byte limit exceeded');
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) throw new RangeError('IPC payload total byte limit exceeded');
  }
  return totalBytes;
}

function registerInvokeHandlers({
  ipcMain,
  clipboard,
  db,
  mqttCoordinator,
  windowManager,
  shell,
  net,
  getUpdater = () => null,
  onInvokeSettled = () => {},
} = {}) {
  if (typeof ipcMain?.handle !== 'function') throw new TypeError('ipcMain is required');
  const registered = [];
  function handle(channel, handler, payloadLimits) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (!windowManager.authorizeIpc(event, channel)) {
          throw new Error('IPC sender is not authorized');
        }
        validateIpcPayload(channel, args, payloadLimits);
        return await handler(event, ...args);
      } finally {
        try { onInvokeSettled(event, channel); } catch { /* Keep observation contained. */ }
      }
    });
    registered.push(channel);
  }

  for (const [channel, method] of Object.entries(DB_HANDLERS)) {
    if (typeof db?.[method] !== 'function') throw new TypeError(`database method ${method} is required`);
    if (channel === IPC_CHANNELS.dbDeleteConnection) {
      handle(channel, async (_event, id) => {
        await mqttCoordinator.disconnect(id);
        return db[method](id);
      });
    } else {
      handle(channel, (_event, ...args) => db[method](...args));
    }
  }
  for (const [channel, method] of [
    [IPC_CHANNELS.mqttConnect, 'connect'],
    [IPC_CHANNELS.mqttDisconnect, 'disconnect'],
    [IPC_CHANNELS.mqttSubscribe, 'subscribe'],
    [IPC_CHANNELS.mqttUnsubscribe, 'unsubscribe'],
    [IPC_CHANNELS.mqttPublish, 'publish'],
  ]) {
    handle(channel, (_event, ...args) => {
      if (method !== 'disconnect' && ['preparing', 'installing'].includes(getUpdater()?.getState().phase)) {
        throw new Error('正在准备安装更新');
      }
      return mqttCoordinator[method](...args);
    });
  }
  handle(IPC_CHANNELS.clipboardReadText, () => clipboard.readText());
  handle(IPC_CHANNELS.clipboardWriteText, (_event, value) => {
    if (typeof value !== 'string') throw new TypeError('Clipboard text must be a string');
    clipboard.writeText(value);
    return { ok: true };
  }, { maxItemBytes: IPC_CLIPBOARD_MAX_BYTES, maxTotalBytes: IPC_CLIPBOARD_MAX_BYTES });
  handle(IPC_CHANNELS.windowOpenHistory, (_event, kind, connId) => {
    windowManager.createHistoryWindow(kind, connId);
    return { ok: true };
  });
  handle(IPC_CHANNELS.windowOpenExternal, async (_event, value) => {
    if (!isSafeExternalUrl(value)) return { ok: false, error: 'Only absolute credential-free HTTPS URLs are allowed' };
    await shell.openExternal(value);
    return { ok: true };
  });
  handle(IPC_CHANNELS.updateCheck, () => getUpdater()?.check() ?? checkForUpdates({ fetch: net.fetch.bind(net) }));
  handle(IPC_CHANNELS.updateState, () => getUpdater()?.getState() ?? { phase: 'idle', supported: false, error: '' });
  for (const [channel, method] of [[IPC_CHANNELS.updateDownload, 'download'], [IPC_CHANNELS.updateCancel, 'cancel'], [IPC_CHANNELS.updateInstall, 'install']]) {
    handle(channel, () => {
      const updater = getUpdater();
      if (!updater) throw new Error('尚未配置应用内更新签名');
      return updater[method]();
    });
  }

  return () => {
    for (const channel of registered) ipcMain.removeHandler?.(channel);
  };
}

module.exports = { validateIpcPayload, registerInvokeHandlers };
