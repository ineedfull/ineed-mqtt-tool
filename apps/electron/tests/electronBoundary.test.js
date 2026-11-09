import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const electronRoot = resolve(import.meta.dirname, '..');
const rootManifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const electronManifest = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'));

function isPathInside(root, candidate, pathImpl = path) {
  const relativePath = pathImpl.relative(root, candidate);
  return relativePath !== ''
    && !pathImpl.isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${pathImpl.sep}`);
}

test('Electron workspace manifest resolves its production entry and product identity', async () => {
  assert.ok(rootManifest.workspaces.includes('apps/*'));
  assert.equal(electronManifest.name, '@ineed-mqtt-tool/electron');
  assert.equal(electronManifest.main, 'electron/main.cjs');
  assert.equal(electronManifest.productName, 'Ineed MQTT Tool');
  assert.equal(electronManifest.build.productName, electronManifest.productName);
  assert.equal(electronManifest.build.appId, 'com.ineedfull.mqtt-tool');

  const mainPath = resolve(electronRoot, electronManifest.main);
  assert.equal(dirname(mainPath), join(electronRoot, 'electron'));
  await access(mainPath);
  assert.equal(require(mainPath).bootstrapElectronApp instanceof Function, true);
});

test('Electron main stays import-safe under ELECTRON_RUN_AS_NODE', () => {
  const electronExecutable = require('electron');
  const mainPath = resolve(electronRoot, electronManifest.main);
  const result = spawnSync(electronExecutable, ['-e', `require(${JSON.stringify(mainPath)})`], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 5_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /startup failed/i);
});

test('Electron main stays import-safe in a non-default browser process', () => {
  const mainPath = resolve(electronRoot, electronManifest.main);
  const script = `
    Object.defineProperty(process, 'type', { value: 'browser' });
    Object.defineProperty(process, 'defaultApp', { value: false });
    require(${JSON.stringify(mainPath)});
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /startup failed/i);
});

test('invalid smoke startup exits promptly with a failure status', async t => {
  const electronExecutable = require('electron');
  const userDataPath = await mkdtemp(join(tmpdir(), 'ineed-smoke-invalid-startup-'));
  t.after(() => rm(userDataPath, { force: true, recursive: true }));
  const env = {
    ...process.env,
    INEED_SMOKE_HISTORY: '',
    INEED_SMOKE_TEST: '1',
    INEED_SMOKE_USER_DATA: userDataPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;

  const result = spawnSync(electronExecutable, [electronRoot], {
    encoding: 'utf8',
    env,
    timeout: 3_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /INEED_SMOKE_HISTORY must be messages or logs/);
});

test('preload executes into one frozen, capability-limited Electron API', async () => {
  const source = await readFile(join(electronRoot, 'electron/preload.cjs'), 'utf8');
  const exposed = [];
  const ipcRenderer = {
    invoke: (channel, ...args) => ({ args, channel }),
    on() {},
    removeListener() {},
    send() {},
  };
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => exposed.push({ api, name }) },
    ipcRenderer,
  };
  const context = vm.createContext({
    require(specifier) {
      assert.equal(specifier, 'electron');
      return electron;
    },
  });

  new vm.Script(source, { filename: 'preload.cjs' }).runInContext(context);

  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].name, 'ineedMqtt');
  assert.equal(exposed[0].api.runtime, 'electron');
  assert.equal(Object.isFrozen(exposed[0].api), true);
  assert.deepEqual(
    Object.keys(exposed[0].api),
    ['runtime', 'db', 'mqtt', 'clipboard', 'window', 'lifecycle', 'update'],
  );
  assert.deepEqual(
    exposed[0].api.window.openHistory('messages', 'boundary-connection'),
    { channel: 'window:open-history', args: ['messages', 'boundary-connection'] },
  );
  assert.equal('ipcRenderer' in exposed[0].api, false);
});

test('default database path requests Electron userData and uses the contract filename', () => {
  const { DATABASE_FILENAME } = require('@ineed-mqtt-tool/persistence-contract');
  const { defaultDatabasePath } = require('../electron/database.cjs');
  const requestedPaths = [];
  const userDataPath = join(repositoryRoot, '.temporary-user-data');
  const app = {
    getPath(name) {
      requestedPaths.push(name);
      return userDataPath;
    },
  };

  assert.equal(DATABASE_FILENAME, 'ineed-mqtt.db');
  assert.equal(defaultDatabasePath(app), join(userDataPath, DATABASE_FILENAME));
  assert.deepEqual(requestedPaths, ['userData']);
});

test('renamed Electron app reuses an existing MQTT Desk database', async t => {
  const { DATABASE_FILENAME } = require('@ineed-mqtt-tool/persistence-contract');
  const { defaultDatabasePath } = require('../electron/database.cjs');
  const directory = await mkdtemp(join(tmpdir(), 'ineed-mqtt-tool-legacy-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const currentUserData = join(directory, 'ineed-mqtt-tool');
  const legacyUserData = join(directory, 'ineed-mqtt-desk');
  await mkdir(legacyUserData);
  await writeFile(join(legacyUserData, DATABASE_FILENAME), 'legacy database');

  assert.equal(
    defaultDatabasePath({ getPath: () => currentUserData }),
    join(legacyUserData, DATABASE_FILENAME),
  );
});

test('smoke exit waits for cleanup and destroyed main and history windows', () => {
  const { createSmokeExitGate } = require('../electron/main.cjs');
  const exitCodes = [];
  const order = [];
  const exitProcess = code => { order.push(`exit:${code}`); exitCodes.push(code); };
  let mainDestroyed = false;
  const mainWindow = {
    destroy: () => { mainDestroyed = true; },
    isDestroyed: () => mainDestroyed,
  };
  const historyWindow = { isDestroyed: () => true };

  const disabled = createSmokeExitGate({ enabled: false, exitProcess });
  disabled.markCleanupComplete();
  disabled.markWindowDestroyed('main', mainWindow);
  disabled.markWindowDestroyed('history', historyWindow);
  assert.deepEqual(exitCodes, []);

  const enabled = createSmokeExitGate({
    beforeExit: () => order.push('marker'),
    enabled: true,
    exitProcess,
  });
  enabled.markWindowDestroyed('history', historyWindow);
  enabled.markCleanupComplete();
  assert.deepEqual(exitCodes, []);
  assert.equal(enabled.destroyFinalWindowAndExit('main', mainWindow), true);
  assert.equal(mainDestroyed, true);
  assert.deepEqual(exitCodes, [0]);
  assert.deepEqual(order, ['marker', 'exit:0']);
  assert.equal(enabled.destroyFinalWindowAndExit('main', mainWindow), false);
  assert.deepEqual(exitCodes, [0]);
});

test('smoke marker uses synchronous output and contains write failures', () => {
  const { writeSmokeMarker } = require('../electron/main.cjs');
  const writes = [];
  const errors = [];

  assert.equal(writeSmokeMarker({
    write: (fd, value) => writes.push([fd, value]),
    onError: error => errors.push(error.message),
  }), true);
  assert.deepEqual(writes, [[1, 'mqtt-tool-history-closed\n']]);
  assert.deepEqual(errors, []);

  assert.equal(writeSmokeMarker({
    write() { throw new Error('pipe closed'); },
    onError: error => errors.push(error.message),
  }), false);
  assert.deepEqual(errors, ['pipe closed']);
});

test('smoke startup requires a supported history request before bootstrap', () => {
  const { readSmokeHistoryKind } = require('../electron/main.cjs');

  assert.equal(readSmokeHistoryKind({ INEED_SMOKE_HISTORY: 'messages' }, true), 'messages');
  assert.equal(readSmokeHistoryKind({ INEED_SMOKE_HISTORY: 'logs' }, true), 'logs');
  for (const value of [undefined, '', '   ', 'metrics']) {
    const env = value === undefined ? {} : { INEED_SMOKE_HISTORY: value };
    assert.throws(() => readSmokeHistoryKind(env, true), /messages or logs/);
  }
});

test('renderer asset containment supports POSIX and Windows paths', () => {
  assert.equal(isPathInside('/app/dist', '/app/dist/assets/app.js', path.posix), true);
  assert.equal(isPathInside('/app/dist', '/app/dist-other/app.js', path.posix), false);
  assert.equal(isPathInside('C:\\app\\dist', 'C:\\app\\dist\\assets\\app.js', path.win32), true);
  assert.equal(isPathInside('C:\\app\\dist', 'C:\\app\\outside\\app.js', path.win32), false);
  assert.equal(isPathInside('C:\\app\\dist', 'D:\\app\\dist\\app.js', path.win32), false);
});

test('production manifest includes the main process, preload, dependencies, and renderer output', () => {
  assert.deepEqual(electronManifest.build.files, [
    'dist/**/*',
    'electron/**/*',
    'node_modules/**/*',
  ]);
});

test('generated renderer HTML references nonempty local JavaScript and CSS assets', async () => {
  const distRoot = join(electronRoot, 'dist');
  const html = await readFile(join(distRoot, 'index.html'), 'utf8');
  const assetReferences = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(([, reference]) => reference)
    .filter(reference => reference.startsWith('./assets/'));

  assert.ok(assetReferences.some(reference => reference.endsWith('.js')));
  assert.ok(assetReferences.some(reference => reference.endsWith('.css')));
  for (const reference of assetReferences) {
    const assetPath = resolve(distRoot, reference);
    assert.equal(isPathInside(distRoot, assetPath, path), true);
    assert.equal((await stat(assetPath)).isFile(), true);
    assert.ok((await stat(assetPath)).size > 0, reference);
  }
});
