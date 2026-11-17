'use strict';

// Composition root only: services own their resources and expose explicit cleanup.
const fs = require('node:fs');
const path = require('node:path');
const { errorMessage, nonblankString } = require('./runtimeValidation.cjs');
const { IPC_CHANNELS, DB_HANDLERS } = require('./ipcContract.cjs');
const { createWindowManager } = require('./windowManager.cjs');
const {
  CLOSE_ACK_TIMEOUT_MS,
  installCloseHandshake,
  createShutdownController,
  shouldCreateMainWindow,
} = require('./closeLifecycle.cjs');
const { createMqttCoordinator } = require('./mqttCoordinator.cjs');
const { checkForUpdates, isSafeExternalUrl } = require('./updateCheck.cjs');
const { createSmokeExitGate, readSmokeHistoryKind, writeSmokeMarker } = require('./smokeRuntime.cjs');
const { registerInvokeHandlers, validateIpcPayload } = require('./ipcHandlers.cjs');

async function bootstrapElectronApp({
  electron = require('electron'),
  mqtt = require('mqtt'),
  createDatabase = require('./database.cjs').createDatabase,
  dirname = __dirname,
  env = process.env,
  platform = process.platform,
} = {}) {
  const { app, BrowserWindow, clipboard, ipcMain, Menu, net, shell } = electron;
  const smokeTest = env.INEED_SMOKE_TEST === '1';
  const smokeHistoryKind = readSmokeHistoryKind(env, smokeTest);
  if (smokeTest) {
    const userDataPath = nonblankString(env.INEED_SMOKE_USER_DATA);
    if (userDataPath === null || !path.isAbsolute(userDataPath)) {
      throw new TypeError('INEED_SMOKE_USER_DATA must be an absolute path');
    }
    app.setPath('userData', userDataPath);
  }
  app.setName('Ineed MQTT Tool');
  const db = createDatabase();
  const windowManager = createWindowManager({
    BrowserWindow,
    dirname,
    devServerUrl: env.VITE_DEV_SERVER_URL || '',
    enableDevTools: env.INEED_OPEN_DEVTOOLS === '1',
  });
  const smokeExitGate = createSmokeExitGate({
    beforeExit: () => writeSmokeMarker({
      onError: error => console.error(
        'mqtt-tool-runtime-error:marker', errorMessage(error),
      ),
    }),
    enabled: smokeTest,
    exitProcess: smokeTest ? code => process.reallyExit(code) : () => {},
  });
  let smokeMainWindow = null;
  let smokeHistoryWindow = null;
  let smokeHistoryWebContents = null;
  let smokeHistoryShutdownRequested = false;
  let smokeCleanupComplete = false;
  let runSmokeShutdown = () => Promise.resolve();
  const smokeHistorySettledChannels = new Set();
  const smokeHistoryQueryChannel = smokeHistoryKind === 'logs'
    ? IPC_CHANNELS.dbQueryHistoryLogs
    : IPC_CHANNELS.dbQueryHistoryMessages;
  const mqttCoordinator = createMqttCoordinator({
    mqtt,
    db,
    send(channel, payload) {
      const win = windowManager.getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
  let nativeUpdater = null;
  const removeHandlers = registerInvokeHandlers({
    ipcMain,
    clipboard,
    db,
    mqttCoordinator,
    windowManager,
    shell,
    net,
    getUpdater: () => nativeUpdater,
    onInvokeSettled(event, channel) {
      if (!smokeTest || event?.sender !== smokeHistoryWebContents) return;
      smokeHistorySettledChannels.add(channel);
      if (
        smokeHistorySettledChannels.has(IPC_CHANNELS.dbGetConnections)
        && smokeHistorySettledChannels.has(smokeHistoryQueryChannel)
        && !smokeHistoryShutdownRequested
      ) {
        smokeHistoryShutdownRequested = true;
        void runSmokeShutdown();
      }
    },
  });
  let closeController = null;
  const shutdownController = createShutdownController({
    mqttCoordinator,
    db,
    removeHandlers,
    getCloseController: () => closeController,
    app,
    onError: (phase, error) => {
      console.error(`[Electron] shutdown ${phase} failed:`, errorMessage(error));
    },
  });
  const shutdown = shutdownController.shutdown;
  let smokeShutdownInFlight = null;
  runSmokeShutdown = () => {
    if (smokeShutdownInFlight !== null) return smokeShutdownInFlight;
    smokeShutdownInFlight = (async () => {
      async function attempt(phase, operation) {
        try {
          await operation();
        } catch (error) {
          console.error(`mqtt-tool-runtime-error:shutdown:${phase}`, errorMessage(error));
        }
      }

      try {
        await attempt('disconnect', () => mqttCoordinator.disconnectAll());
        await attempt('flush', () => mqttCoordinator.flush());
        await attempt('database', () => db.closeDatabase());
      } finally {
        await attempt('mqtt-dispose', () => mqttCoordinator.dispose());
        await attempt('handlers', () => removeHandlers());
        await attempt('close-controller', () => closeController?.dispose());
      }
      smokeCleanupComplete = true;
      smokeExitGate.markCleanupComplete();
      for (const [role, window] of [
        ['history', smokeHistoryWindow],
        ['main', smokeMainWindow],
      ]) {
        if (role === 'main') {
          smokeExitGate.destroyFinalWindowAndExit(role, window);
          continue;
        }
        if (window && !window.isDestroyed()) window.destroy();
        if (!window?.isDestroyed()) {
          console.error(
            `mqtt-tool-runtime-error:shutdown:${role}`,
            `${role} window did not close`,
          );
          continue;
        }
        smokeExitGate.markWindowDestroyed(role, window);
      }
    })();
    return smokeShutdownInFlight;
  };

  function configureSmokeWindow(window, role, onLoaded) {
    if (!smokeTest) return;
    const report = (kind, detail) => {
      console.error(`mqtt-tool-runtime-error:${role}:${kind}`, errorMessage(detail));
    };
    window.webContents.on('preload-error', (_event, _preloadPath, error) => {
      report('preload', error);
    });
    window.webContents.on('did-fail-load', (
      _event, errorCode, errorDescription, _validatedUrl, isMainFrame,
    ) => {
      if (isMainFrame !== false && errorCode !== -3) report('load', errorDescription);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      if (!smokeCleanupComplete && details?.reason !== 'clean-exit') {
        report('renderer', details?.reason);
      }
    });
    window.webContents.on('unresponsive', () => report('unresponsive', 'renderer unresponsive'));
    window.webContents.on('console-message', details => {
      if (details?.level === 'error' || Number(details?.level) >= 2) {
        report('console', details?.message);
      }
    });
    window.webContents.once('did-finish-load', onLoaded);
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'iNeed MQTT Tool', submenu: [{ role: 'quit' }] },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
  ]));

  await app.whenReady();
  if (app.isPackaged && !smokeTest) {
    const trustPath = path.join(process.resourcesPath, 'mqtt-update-trust.json');
    let trust;
    try { trust = JSON.parse(fs.readFileSync(trustPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (trust) {
      if (trust.schemaVersion !== 1 || !trust.publicKey) throw new Error('Invalid update trust configuration');
      const { createUpdateController } = require('./updateController.cjs');
      const { requestUpdatePreparation } = require('./updatePreparation.cjs');
      nativeUpdater = createUpdateController({
        engine: require('electron-updater').autoUpdater,
        currentVersion: app.getVersion(), platform, publicKey: trust.publicKey,
        onState: state => {
          const window = windowManager.getMainWindow();
          if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.updateChanged, state);
        },
        prepare: async () => {
          await mqttCoordinator.disconnectAll({ strict: true });
          await mqttCoordinator.flush();
          await requestUpdatePreparation({ window: windowManager.getMainWindow(), ipcMain });
          await db.checkpointForUpdate();
        },
      });
    }
  }
  app.dock?.setIcon(path.join(dirname, 'assets', 'icon.png'));
  const mainWindow = windowManager.createMainWindow(window => {
    if (smokeTest) {
      smokeMainWindow = window;
    }
    configureSmokeWindow(window, 'main', () => {
      console.log('mqtt-tool-ready');
      const historyKind = smokeHistoryKind;
      try {
        const historyWindow = windowManager.createHistoryWindow(
          historyKind,
          'smoke-connection',
          candidate => {
            smokeHistoryWindow = candidate;
            smokeHistoryWebContents = candidate.webContents;
            configureSmokeWindow(candidate, 'history', () => {
              console.log('mqtt-tool-history-opened');
            });
          },
        );
        if (historyWindow.isDestroyed()) {
          throw new Error('history window was destroyed before loading');
        }
      } catch (error) {
        console.error('mqtt-tool-runtime-error:history:control', errorMessage(error));
        void runSmokeShutdown();
      }
    });
  });
  closeController = installCloseHandshake({
    window: mainWindow,
    ipcMain,
    isBlocked: () => nativeUpdater?.getState().phase === 'preparing',
    finalize: () => shutdown(mainWindow),
  });
  app.on('activate', () => {
    if (shouldCreateMainWindow({ windowManager, shutdownController })) {
      const nextWindow = windowManager.createMainWindow();
      closeController = installCloseHandshake({
        window: nextWindow,
        ipcMain,
        isBlocked: () => nativeUpdater?.getState().phase === 'preparing',
        finalize: () => shutdown(nextWindow),
      });
    }
  });
  app.on('window-all-closed', () => {
    if (platform !== 'darwin' && !shutdownController.started) {
      void shutdown(windowManager.getMainWindow());
    }
  });
  return Object.freeze({ db, mqttCoordinator, windowManager, shutdown });
}

module.exports = {
  CLOSE_ACK_TIMEOUT_MS,
  DB_HANDLERS,
  IPC_CHANNELS,
  bootstrapElectronApp,
  checkForUpdates,
  createMqttCoordinator,
  createShutdownController,
  createSmokeExitGate,
  createWindowManager,
  installCloseHandshake,
  isSafeExternalUrl,
  registerInvokeHandlers,
  readSmokeHistoryKind,
  shouldCreateMainWindow,
  validateIpcPayload,
  writeSmokeMarker,
};

if (
  require.main === module
  || (process.type === 'browser' && process.defaultApp === true)
) {
  void bootstrapElectronApp().catch(error => {
    if (process.env.INEED_SMOKE_TEST === '1') {
      try {
        fs.writeSync(2, `[Electron] startup failed: ${error?.stack || errorMessage(error)}\n`);
      } finally {
        process.reallyExit(1);
      }
    }
    console.error('[Electron] startup failed:', error);
    process.exitCode = 1;
  });
}
