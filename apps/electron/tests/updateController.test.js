import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createUpdateController, signedUpdatePayload } = require('../electron/updateController.cjs');

// Real files and signatures protect our trust boundary; only the OS installer is replaced.
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mqtt-updater-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'mqtt.zip');
  const bytes = Buffer.from('isolated signed update artifact');
  await writeFile(file, bytes);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const info = { version: '0.1.1', files: [{ url: 'https://downloads.ineedfull.com/ineed-mqtt-tool/0.1.1/test/mqtt.zip',
    size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }],
  ineedChannel: 'electron-macos-arm64', releaseNotes: 'Fixes' };
  info.ineedSignature = sign(null, Buffer.from(signedUpdatePayload(info)), privateKey).toString('base64');
  const engine = new EventEmitter();
  engine.checkForUpdates = async () => ({ updateInfo: info });
  engine.downloadUpdate = async () => {
    engine.emit('download-progress', { transferred: bytes.length, total: bytes.length, percent: 100 });
    engine.emit('update-downloaded', info);
    return [file];
  };
  let installs = 0;
  engine.quitAndInstall = () => { installs++; };
  engine.setFeedURL = () => {};
  const controller = createUpdateController({ engine, currentVersion: '0.1.0', platform: 'darwin', arch: 'arm64',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    prepare: async () => {}, ...overrides });
  return { controller, engine, info, file, privateKey, installs: () => installs };
}

test('verified real bytes become ready; installation waits for successful preparation', async t => {
  let releasePreparation;
  const prepared = new Promise(resolve => { releasePreparation = resolve; });
  const f = await fixture(t, { prepare: () => prepared });
  assert.equal((await f.controller.check()).automatic, true);
  assert.equal((await f.controller.download()).phase, 'ready');
  const pending = f.controller.install();
  await Promise.resolve();
  assert.equal(f.controller.getState().phase, 'preparing');
  assert.equal(f.installs(), 0);
  releasePreparation();
  await pending;
  assert.equal(f.installs(), 1);
  assert.equal(f.engine.autoInstallOnAppQuit, false);
  assert.equal(f.engine.autoDownload, false);
});

test('corrupted download cannot become ready or be installed', async t => {
  const f = await fixture(t);
  await f.controller.check();
  await writeFile(f.file, 'corrupted');
  await assert.rejects(f.controller.download(), /size|checksum/i);
  await assert.rejects(f.controller.install(), /ready|校验/i);
  assert.equal(f.installs(), 0);
});

test('download event alone does not grant installation before verification finishes', async t => {
  const f = await fixture(t);
  await f.controller.check();
  f.engine.emit('update-downloaded', f.info);
  await assert.rejects(f.controller.install(), /ready|校验/i);
  assert.equal(f.installs(), 0);
});

test('signature and channel changes reject metadata before downloading', async t => {
  for (const mutation of [info => { info.version = '0.2.0'; }, info => { info.ineedChannel = 'electron-macos-x64'; },
    info => { info.files[0].url = 'http://example.com/x.zip'; }]) {
    const f = await fixture(t);
    mutation(f.info);
    await assert.rejects(f.controller.check(), /signature|channel|HTTPS/i);
    await assert.rejects(f.controller.download(), /available/i);
  }
});

test('unconfigured trust and unsupported deb installation fail closed', async () => {
  const engine = new EventEmitter();
  engine.checkForUpdates = () => { throw new Error('network must not run'); };
  for (const options of [{}, { platform: 'linux', arch: 'x64', publicKey: 'irrelevant' }]) {
    const controller = createUpdateController({ engine, currentVersion: '0.1.0', ...options });
    await assert.rejects(controller.check(), /配置|unsupported/i);
    await assert.rejects(controller.download(), /available/i);
  }
});

test('failed preparation keeps the verified update retryable and never installs', async t => {
  let fail = true;
  const f = await fixture(t, { prepare: async () => { if (fail) throw new Error('history flush failed'); } });
  await f.controller.check();
  await f.controller.download();
  await assert.rejects(f.controller.install(), /history flush failed/);
  assert.equal(f.installs(), 0);
  assert.equal(f.controller.getState().phase, 'ready');
  fail = false;
  await f.controller.install();
  assert.equal(f.installs(), 1);
});

test('changed cached bytes are rechecked at installation', async t => {
  const f = await fixture(t);
  await f.controller.check();
  await f.controller.download();
  await writeFile(f.file, 'replacement');
  await assert.rejects(f.controller.install(), /size|checksum/i);
  assert.equal(f.installs(), 0);
});

test('duplicate requests cannot start a second check or install', async t => {
  let unblock;
  const f = await fixture(t, { prepare: () => new Promise(resolve => { unblock = resolve; }) });
  await f.controller.check();
  await f.controller.download();
  const pending = f.controller.install();
  await Promise.resolve();
  await assert.rejects(f.controller.check(), /busy/i);
  await assert.rejects(f.controller.install(), /busy/i);
  while (!unblock) await new Promise(resolve => setImmediate(resolve));
  unblock();
  await pending;
  assert.equal(f.installs(), 1);
});

test('real electron-updater streams local artifacts and rejects corrupt bytes before readiness', async t => {
  const { AppImageUpdater } = require('electron-updater');
  const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'mqtt-real-updater-'));
  const previousAppImage = process.env.APPIMAGE;
  process.env.APPIMAGE = path.join(directory, 'old.AppImage');
  t.after(async () => {
    if (previousAppImage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = previousAppImage;
    await rm(directory, { recursive: true, force: true });
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const bytes = Buffer.alloc(128 * 1024, 42);
  const info = { version: '0.1.1', ineedChannel: 'electron-linux-x64', files: [{
    url: 'https://downloads.ineedfull.com/ineed-mqtt-tool/0.1.1/test/mqtt.AppImage', size: bytes.length,
    sha512: createHash('sha512').update(bytes).digest('base64') }] };
  info.ineedSignature = sign(null, Buffer.from(signedUpdatePayload(info)), privateKey).toString('base64');
  let corrupt = true;
  const server = createServer((incoming, outgoing) => {
    if (incoming.url.includes('.yml')) return outgoing.end(JSON.stringify(info));
    outgoing.writeHead(200, { 'Content-Length': bytes.length });
    const body = corrupt ? Buffer.alloc(bytes.length, 43) : bytes;
    for (let start = 0; start < body.length; start += 4096) outgoing.write(body.subarray(start, start + 4096));
    outgoing.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = path.join(directory, 'app-update.yml');
  await writeFile(config, 'updaterCacheDirName: isolated-update-cache\n');
  class LocalTransport extends ElectronHttpExecutor {
    createRequest(options, callback) {
      // Only the transport is substituted. The real updater parses, downloads and hashes.
      return request({ ...options, protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1', port: server.address().port }, callback);
    }
  }
  const engine = new AppImageUpdater(null, { version: '0.1.0', name: 'isolated-mqtt-test', isPackaged: true,
    appUpdateConfigPath: config, userDataPath: directory, baseCachePath: directory,
    whenReady: async () => {}, onQuit: () => {}, quit: () => { throw new Error('must not quit'); } });
  engine._testOnlyOptions = { platform: 'linux' };
  engine.httpExecutor = new LocalTransport();
  engine.logger = { info() {}, warn() {}, error() {}, debug() {} };
  engine.disableDifferentialDownload = true;
  const controller = createUpdateController({ engine, currentVersion: '0.1.0', platform: 'linux', arch: 'x64', appimage: true,
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }), prepare: async () => {} });
  await controller.check();
  await assert.rejects(controller.download(), /checksum/i);
  assert.equal(controller.getState().phase, 'error');
  corrupt = false;
  await controller.download();
  assert.equal(controller.getState().phase, 'ready');
  assert.equal(controller.getState().transferred, 131072);
});


test('both synchronous and asynchronous installer errors return to ready for retry', async t => {
  const f = await fixture(t);
  await f.controller.check();
  await f.controller.download();
  f.engine.quitAndInstall = () => { throw new Error('installer unavailable'); };
  await assert.rejects(f.controller.install(), /installer unavailable/);
  assert.equal(f.controller.getState().phase, 'ready');
  f.engine.quitAndInstall = () => { f.engine.emit('error', new Error('permission denied')); };
  await f.controller.install();
  assert.equal(f.controller.getState().phase, 'ready');
  assert.equal(f.controller.getState().error, 'permission denied');
});
