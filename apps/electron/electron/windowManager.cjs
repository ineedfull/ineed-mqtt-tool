'use strict';

// Owns window records, renderer navigation, and sender authorization.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { errorMessage, nonblankString } = require('./runtimeValidation.cjs');
const { INVOKE_CHANNELS, HISTORY_CHANNELS } = require('./ipcContract.cjs');

function createWindowManager({
  BrowserWindow,
  dirname = __dirname,
  devServerUrl = '',
  enableDevTools = false,
  onNavigationError = error => console.error('[Electron] renderer navigation failed:', errorMessage(error)),
} = {}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow is required');
  const preload = path.join(dirname, 'preload.cjs');
  const rendererEntry = path.join(dirname, '..', 'dist', 'index.html');
  const windows = new Set();
  const historyWindows = new Map();
  const windowRecords = new Map();
  let mainWindow = null;

  function browserWindowOptions(options) {
    return {
      ...options,
      icon: path.join(dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
      },
    };
  }

  function secureWebContents(win) {
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    win.webContents.on?.('will-navigate', event => event.preventDefault());
    win.webContents.on?.('will-attach-webview', event => event.preventDefault());
  }

  function track(win, role, kind = null) {
    windows.add(win);
    secureWebContents(win);
    const record = {
      closed: false,
      committedUrl: null,
      kind,
      navigationTail: null,
      pendingUrls: new Map(),
      role,
      window: win,
    };
    const contents = win.webContents;
    windowRecords.set(contents, record);
    win.on?.('closed', () => {
      record.closed = true;
      record.pendingUrls.clear();
      windows.delete(win);
      windowRecords.delete(contents);
      if (mainWindow === win) mainWindow = null;
    });
    return win;
  }

  function loadRenderer(win, query = null) {
    if (devServerUrl) {
      const url = new URL(devServerUrl);
      if (query) {
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      }
      return win.loadURL(url.toString());
    }
    if (query) return win.loadFile(rendererEntry, { query });
    return win.loadFile(rendererEntry);
  }

  function rendererUrl(query = null) {
    const url = devServerUrl ? new URL(devServerUrl) : pathToFileURL(rendererEntry);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  function navigateRenderer(win, query = null) {
    const record = windowRecords.get(win.webContents);
    if (!record || record.closed) return;
    const targetUrl = rendererUrl(query);
    record.pendingUrls.set(targetUrl, (record.pendingUrls.get(targetUrl) || 0) + 1);

    const releaseTarget = () => {
      const remaining = (record.pendingUrls.get(targetUrl) || 1) - 1;
      if (remaining > 0) record.pendingUrls.set(targetUrl, remaining);
      else record.pendingUrls.delete(targetUrl);
    };
    const reportNavigationError = error => {
      try { onNavigationError(error); } catch { /* Keep navigation failures contained. */ }
    };
    const navigate = () => {
      if (record.closed || windowRecords.get(win.webContents) !== record || win.isDestroyed()) {
        releaseTarget();
        return Promise.resolve();
      }
      let navigation;
      try {
        navigation = loadRenderer(win, query);
      } catch (error) {
        reportNavigationError(error);
        releaseTarget();
        return Promise.resolve();
      }
      return Promise.resolve(navigation)
        .then(() => {
          if (!record.closed && windowRecords.get(win.webContents) === record && !win.isDestroyed()) {
            record.committedUrl = targetUrl;
          }
        })
        .catch(reportNavigationError)
        .finally(releaseTarget);
    };

    const navigation = record.navigationTail
      ? record.navigationTail.then(navigate)
      : navigate();
    record.navigationTail = navigation;
    navigation.then(() => {
      if (record.navigationTail === navigation) record.navigationTail = null;
    });
  }

  function recordAllowsUrl(record, url) {
    return url === record.committedUrl || record.pendingUrls.has(url);
  }

  function createMainWindow(beforeLoad) {
    const win = track(new BrowserWindow(browserWindowOptions({
      width: 1360,
      height: 860,
      minWidth: 1120,
      minHeight: 720,
      title: 'iNeed MQTT Tool',
      autoHideMenuBar: true,
      backgroundColor: '#f3f4f6',
    })), 'main');
    mainWindow = win;
    beforeLoad?.(win);
    navigateRenderer(win);
    if (devServerUrl && enableDevTools) win.webContents.openDevTools();
    return win;
  }

  function createHistoryWindow(kind, connId, beforeLoad) {
    if (kind !== 'messages' && kind !== 'logs') {
      throw new TypeError('history kind must be messages or logs');
    }
    const normalizedConnId = nonblankString(connId);
    if (normalizedConnId === null) throw new TypeError('connection id must be a nonblank string');
    const existing = historyWindows.get(kind);
    if (existing && !existing.isDestroyed()) {
      navigateRenderer(existing, { history: kind, connId: normalizedConnId });
      existing.focus();
      return existing;
    }
    historyWindows.delete(kind);
    const win = track(new BrowserWindow(browserWindowOptions({
      width: 1180,
      height: 760,
      minWidth: 900,
      minHeight: 600,
      title: kind === 'logs' ? '历史日志' : '历史消息',
      backgroundColor: '#f3f4f6',
    })), 'history', kind);
    historyWindows.set(kind, win);
    win.on?.('closed', () => {
      if (historyWindows.get(kind) === win) historyWindows.delete(kind);
    });
    beforeLoad?.(win);
    navigateRenderer(win, { history: kind, connId: normalizedConnId });
    return win;
  }

  return Object.freeze({
    authorizeIpc(event, channel) {
      try {
        const record = windowRecords.get(event?.sender);
        if (
          !record
          || record.window.isDestroyed()
          || event.senderFrame !== event.sender.mainFrame
          || !recordAllowsUrl(record, event.senderFrame.url)
          || !INVOKE_CHANNELS.has(channel)
        ) return false;
        if (record.role === 'main') return true;
        return HISTORY_CHANNELS[record.kind]?.has(channel) === true;
      } catch {
        return false;
      }
    },
    createMainWindow,
    createHistoryWindow,
    getMainWindow: () => mainWindow,
    getWindows: () => [...windows],
  });
}

module.exports = { createWindowManager };
