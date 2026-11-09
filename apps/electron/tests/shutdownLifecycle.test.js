import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  DB_HANDLERS,
  bootstrapElectronApp,
  createShutdownController,
} = require('../electron/main.cjs');

test('shutdown isolates every phase failure and still destroys and quits', async () => {
  const attempts = [];
  const controller = createShutdownController({
    mqttCoordinator: {
      async disconnectAll() { attempts.push('disconnect'); throw new Error('disconnect failed'); },
      flush() { attempts.push('flush'); throw new Error('flush failed'); },
      dispose() { attempts.push('mqtt dispose'); throw new Error('mqtt dispose failed'); },
    },
    db: { closeDatabase() { attempts.push('db close'); throw new Error('db close failed'); } },
    removeHandlers() { attempts.push('remove handlers'); throw new Error('handlers failed'); },
    getCloseController: () => ({
      dispose() { attempts.push('close dispose'); throw new Error('close dispose failed'); },
    }),
    app: { quit() { attempts.push('quit'); throw new Error('quit failed'); } },
  });
  const window = {
    isDestroyed: () => false,
    destroy() { attempts.push('destroy'); throw new Error('destroy failed'); },
  };

  const result = await controller.shutdown(window);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(error => error.phase), [
    'disconnect', 'flush', 'database', 'mqtt-dispose', 'handlers',
    'close-controller', 'destroy', 'quit',
  ]);
  assert.deepEqual(attempts, [
    'disconnect', 'flush', 'db close', 'mqtt dispose', 'remove handlers',
    'close dispose', 'destroy', 'quit',
  ]);
  assert.equal(controller.running, false);
});

test('shutdown flushes messages received during disconnect and deduplicates concurrent calls', async () => {
  const attempts = [];
  let releaseDisconnect;
  const disconnecting = new Promise(resolvePromise => { releaseDisconnect = resolvePromise; });
  const controller = createShutdownController({
    mqttCoordinator: {
      async disconnectAll() {
        attempts.push('disconnect');
        await disconnecting;
        attempts.push('last message');
      },
      flush() { attempts.push('flush after ' + attempts.at(-1)); },
      dispose() { attempts.push('mqtt dispose'); },
    },
    db: { closeDatabase() { attempts.push('db close'); } },
    removeHandlers() { attempts.push('remove handlers'); },
    getCloseController: () => ({ dispose() { attempts.push('close dispose'); } }),
    app: { quit() { attempts.push('quit'); } },
  });
  const window = { isDestroyed: () => false, destroy() { attempts.push('destroy'); } };

  const first = controller.shutdown(window);
  const second = controller.shutdown(window);
  assert.strictEqual(second, first);
  releaseDisconnect();
  assert.deepEqual(await first, { ok: true, errors: [] });
  assert.deepEqual(attempts, [
    'disconnect', 'last message', 'flush after last message', 'db close',
    'mqtt dispose', 'remove handlers', 'close dispose', 'destroy', 'quit',
  ]);
  assert.equal(controller.running, false);
});

test('unexpected window-all-closed runs controlled shutdown before quitting', async () => {
  const attempts = [];
  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.openDevTools = () => {};
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
    }
    destroy() { this.destroyed = true; attempts.push('destroy'); }
    isDestroyed() { return this.destroyed; }
    loadFile() { return Promise.resolve(); }
  }
  const app = new EventEmitter();
  app.setName = () => {};
  app.whenReady = async () => {};
  app.quit = () => attempts.push('quit');
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  ipcMain.removeHandler = () => {};
  const db = Object.fromEntries(Object.values(DB_HANDLERS).map(method => [method, () => {}]));
  db.closeDatabase = () => attempts.push('database');
  const runtime = await bootstrapElectronApp({
    createDatabase: () => db,
    electron: {
      app,
      BrowserWindow: FakeBrowserWindow,
      ipcMain,
      Menu: { buildFromTemplate: template => template, setApplicationMenu() {} },
      net: { fetch() {} },
      shell: { openExternal() {} },
    },
    env: {},
    mqtt: { connect() { throw new Error('not expected'); } },
    platform: 'linux',
  });

  app.emit('window-all-closed');
  await runtime.shutdown();

  assert.deepEqual(attempts, ['database', 'destroy', 'quit']);
});
