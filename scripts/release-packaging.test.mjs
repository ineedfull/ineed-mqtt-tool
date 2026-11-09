import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APP_IDENTIFIER,
  cleanArtifactDirectories,
  formatBuildTime,
  hostReleaseTarget,
  packageAll,
  pruneElectronPackage,
  releaseArtifactName,
  releaseManifestName,
  releaseTargetsForPlatform,
} from './release-packaging.mjs';
import {
  assertAllowedArtifactPath,
  findForbiddenEntry,
  verifyReleasePackages,
} from './verify-release-packages.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mqtt-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function writeReleaseFixture({ root, runtime, version, buildTime, target }) {
  const directory = path.join(root, 'artifacts', runtime);
  const name = releaseArtifactName({ runtime, version, buildTime, target });
  const contents = Buffer.from(`${runtime}-${target.platform}-${target.architecture}-artifact`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), contents);
  await writeFile(path.join(directory, releaseManifestName(target)), `${JSON.stringify({
    schemaVersion: 1,
    runtime,
    product: 'Ineed MQTT Tool',
    identifier: APP_IDENTIFIER,
    version,
    buildTime,
    platform: target.platform,
    architecture: target.architecture,
    artifact: { name, size: contents.length, sha256: sha256(contents) },
  })}\n`);
}

test('formats one portable UTC build timestamp and rejects invalid dates', () => {
  assert.equal(formatBuildTime(new Date('2026-07-24T03:04:05.000Z')), '20260724T030405Z');
  assert.throws(() => formatBuildTime(new Date('invalid')), /valid date/i);
});

test('maps supported hosts to explicit platform and architecture labels', () => {
  assert.deepEqual(hostReleaseTarget({ platform: 'darwin', arch: 'arm64' }), {
    platform: 'macos',
    architecture: 'arm64',
    rustTarget: 'aarch64-apple-darwin',
    electron: { target: 'dmg', extension: 'dmg' },
    tauri: { bundles: 'dmg', extension: 'dmg' },
  });
  assert.deepEqual(hostReleaseTarget({ platform: 'win32', arch: 'x64' }), {
    platform: 'windows',
    architecture: 'x64',
    rustTarget: 'x86_64-pc-windows-msvc',
    electron: { target: 'nsis', extension: 'exe' },
    tauri: { bundles: 'nsis', extension: 'exe' },
  });
  assert.deepEqual(hostReleaseTarget({ platform: 'linux', arch: 'x64' }), {
    platform: 'linux',
    architecture: 'x64',
    rustTarget: 'x86_64-unknown-linux-gnu',
    electron: { target: 'AppImage', extension: 'AppImage' },
    tauri: { bundles: 'appimage', extension: 'AppImage' },
  });
  assert.throws(() => hostReleaseTarget({ platform: 'aix', arch: 'ppc64' }), /unsupported release host/i);
});

test('release target matrices preserve every legacy desktop architecture', () => {
  assert.deepEqual(
    releaseTargetsForPlatform('darwin').map(({ platform, architecture, rustTarget }) => ({
      platform, architecture, rustTarget,
    })),
    [
      { platform: 'macos', architecture: 'arm64', rustTarget: 'aarch64-apple-darwin' },
      { platform: 'macos', architecture: 'x64', rustTarget: 'x86_64-apple-darwin' },
    ],
  );
  assert.deepEqual(
    releaseTargetsForPlatform('win32').map(({ platform, architecture, rustTarget }) => ({
      platform, architecture, rustTarget,
    })),
    [
      { platform: 'windows', architecture: 'x64', rustTarget: 'x86_64-pc-windows-msvc' },
      { platform: 'windows', architecture: 'ia32', rustTarget: 'i686-pc-windows-msvc' },
    ],
  );
  assert.deepEqual(
    releaseTargetsForPlatform('linux').map(({ platform, architecture, rustTarget }) => ({
      platform, architecture, rustTarget,
    })),
    [{ platform: 'linux', architecture: 'x64', rustTarget: 'x86_64-unknown-linux-gnu' }],
  );
  assert.throws(() => releaseTargetsForPlatform('aix'), /unsupported release platform/i);
});

test('release names separate runtimes while sharing version, target, and build time', () => {
  const target = hostReleaseTarget({ platform: 'darwin', arch: 'arm64' });
  const buildTime = '20260724T030405Z';
  assert.equal(
    releaseArtifactName({ runtime: 'electron', version: '0.1.0', buildTime, target }),
    'Ineed-MQTT-Tool-0.1.0-electron-macos-arm64-20260724T030405Z.dmg',
  );
  assert.equal(
    releaseArtifactName({ runtime: 'tauri', version: '0.1.0', buildTime, target }),
    'Ineed-MQTT-Tool-0.1.0-tauri-macos-arm64-20260724T030405Z.dmg',
  );
  assert.equal(
    releaseArtifactName({
      runtime: 'electron',
      version: '0.1.0',
      buildTime,
      target: releaseTargetsForPlatform('win32')[1],
    }),
    'Ineed-MQTT-Tool-0.1.0-electron-windows-ia32-20260724T030405Z.exe',
  );
});

test('packageAll builds both runtimes for every target in the host platform matrix', async (t) => {
  const root = await temporaryDirectory(t);
  const buildTime = '20260724T030405Z';
  const calls = [];
  await mkdir(path.join(root, 'apps/electron'), { recursive: true });
  await mkdir(path.join(root, 'apps/tauri/src-tauri'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"version":"0.1.0"}\n');
  await writeFile(path.join(root, 'apps/electron/package.json'), JSON.stringify({
    version: '0.1.0',
    build: { appId: APP_IDENTIFIER },
  }));
  await writeFile(path.join(root, 'apps/tauri/src-tauri/tauri.conf.json'), JSON.stringify({
    version: '0.1.0',
    identifier: APP_IDENTIFIER,
  }));
  await writeFile(path.join(root, 'apps/tauri/src-tauri/Cargo.toml'), '[package]\nversion = "0.1.0"\n');
  const runtimeBuilders = Object.fromEntries(['electron', 'tauri'].map((runtime) => [runtime, async ({
    nativeRoot, target,
  }) => {
    calls.push(`${runtime}:${target.platform}:${target.architecture}`);
    const artifactPath = path.join(nativeRoot, `${runtime}.${target[runtime].extension}`);
    await writeFile(artifactPath, `${runtime}-${target.architecture}`);
    return artifactPath;
  }]));

  const result = await packageAll({
    projectRoot: root,
    environment: { RELEASE_BUILD_TIME: buildTime },
    platform: 'darwin',
    runtimeBuilders,
  });

  assert.deepEqual(calls, [
    'electron:macos:arm64',
    'tauri:macos:arm64',
    'electron:macos:x64',
    'tauri:macos:x64',
  ]);
  assert.equal(result.buildTime, buildTime);
  assert.equal(result.manifests.length, 4);
  assert.equal((await readdir(path.join(root, 'artifacts/electron'))).length, 4);
  assert.equal((await readdir(path.join(root, 'artifacts/tauri'))).length, 4);
});

test('cleans only the two runtime collection directories', async (t) => {
  const root = await temporaryDirectory(t);
  const artifactRoot = path.join(root, 'artifacts');
  await mkdir(path.join(artifactRoot, 'electron'), { recursive: true });
  await mkdir(path.join(artifactRoot, 'tauri'), { recursive: true });
  await writeFile(path.join(artifactRoot, 'electron', 'stale.dmg'), 'stale');
  await writeFile(path.join(artifactRoot, 'tauri', 'stale.dmg'), 'stale');

  const result = await cleanArtifactDirectories({ projectRoot: root, artifactRoot });

  assert.deepEqual(result, {
    electron: path.join(artifactRoot, 'electron'),
    tauri: path.join(artifactRoot, 'tauri'),
  });
  assert.deepEqual(await readdir(result.electron), []);
  assert.deepEqual(await readdir(result.tauri), []);
});

test('artifact path guard rejects traversal and source-app destinations', async (t) => {
  const root = await temporaryDirectory(t);
  const artifactRoot = path.join(root, 'artifacts');
  await mkdir(path.join(artifactRoot, 'electron'), { recursive: true });
  await assert.doesNotReject(assertAllowedArtifactPath(
    path.join(artifactRoot, 'electron', 'release.dmg'),
    { projectRoot: root, artifactRoot },
  ));
  await assert.rejects(assertAllowedArtifactPath(path.join(root, 'apps', 'electron', 'release.dmg'), {
    projectRoot: root,
    artifactRoot,
  }), /artifacts directory/i);
  await assert.rejects(assertAllowedArtifactPath(path.join(artifactRoot, '..', 'outside.dmg'), {
    projectRoot: root,
    artifactRoot,
  }), /artifacts directory/i);
});

test('artifact path guard rejects a symlinked collection root', async (t) => {
  const root = await temporaryDirectory(t);
  const external = await temporaryDirectory(t);
  await symlink(external, path.join(root, 'artifacts'));
  await assert.rejects(assertAllowedArtifactPath(path.join(root, 'artifacts', 'electron', 'release.dmg'), {
    projectRoot: root,
  }), /real directory/i);
});

test('forbidden entry policy rejects databases, secrets, logs, maps, tests, and fixtures', () => {
  const forbidden = [
    'data/client.db',
    'data/client.db-wal',
    'data/client.db-shm',
    '.env',
    'config/.env.production',
    'logs/runtime.log',
    'assets/main.js.map',
    'node_modules/example/tests/index.js',
    'node_modules/example/test/index.js',
    'app/fixtures/sample.json',
  ];
  for (const entry of forbidden) {
    assert.match(findForbiddenEntry([entry]) ?? '', /forbidden package entry/i, entry);
  }
  assert.equal(findForbiddenEntry(['app/dist/index.html', 'app/dist/assets/main.js']), null);
});

test('forbidden content policy rejects development URLs and sensitive material', () => {
  assert.match(
    findForbiddenEntry(['app/dist/main.js'], [{ path: 'app/dist/main.js', contents: 'http://localhost:5173' }]) ?? '',
    /development URL/i,
  );
  assert.match(
    findForbiddenEntry(['app/config.txt'], [{ path: 'app/config.txt', contents: '-----BEGIN PRIVATE KEY-----' }]) ?? '',
    /sensitive material/i,
  );
});

test('Electron afterPack pruning removes forbidden and renderer-only package files', async (t) => {
  const root = await temporaryDirectory(t);
  const appRoot = path.join(root, 'resources', 'app');
  const files = {
    'dist/index.html': '<main></main>',
    'electron/main.cjs': 'module.exports = {};',
    'node_modules/@ineed-mqtt-tool/workbench/e2e/support/dev.mjs': 'http://localhost:5173',
    'node_modules/@ineed-mqtt-tool/mqtt-contract/package.json': await readFile(path.join(projectRoot, 'packages/mqtt-contract/package.json'), 'utf8'),
    'node_modules/@ineed-mqtt-tool/mqtt-contract/src/endpoint.js': await readFile(path.join(projectRoot, 'packages/mqtt-contract/src/endpoint.js'), 'utf8'),
    'node_modules/@ineed-mqtt-tool/mqtt-contract/tests/endpoint.test.js': 'test',
    'node_modules/@ineed-mqtt-tool/runtime-contract/tests/runtime.test.js': 'test',
    'node_modules/@ineed-mqtt-tool/persistence-contract/src/schema.js': 'export {};',
    'node_modules/mqtt/build/index.js': 'module.exports = {};',
    'node_modules/mqtt/build/index.js.map': '{}',
    '.env.production': 'TOKEN=secret',
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(appRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }

  await pruneElectronPackage(appRoot);

  // The production main requires this shared module before creating a window.
  const packagedRequire = createRequire(path.join(appRoot, 'electron/main.cjs'));
  const { buildBrokerUrl } = packagedRequire('@ineed-mqtt-tool/mqtt-contract/endpoint');
  assert.equal(buildBrokerUrl({ protocol: 'ws', host: '::1', port: 8083, path: '/custom?site=1' }), 'ws://[::1]:8083/custom?site=1');

  await assert.doesNotReject(readFile(path.join(appRoot, 'dist/index.html')));
  await assert.doesNotReject(readFile(path.join(
    appRoot,
    'node_modules/@ineed-mqtt-tool/persistence-contract/src/schema.js',
  )));
  await assert.doesNotReject(readFile(path.join(appRoot, 'node_modules/mqtt/build/index.js')));
  for (const relativePath of [
    'node_modules/@ineed-mqtt-tool/workbench',
    'node_modules/@ineed-mqtt-tool/mqtt-contract/tests/endpoint.test.js',
    'node_modules/@ineed-mqtt-tool/runtime-contract',
    'node_modules/mqtt/build/index.js.map',
    '.env.production',
  ]) {
    await assert.rejects(readFile(path.join(appRoot, relativePath)));
  }
});

test('Electron and Tauri retain the same root version and application identity', async () => {
  const [rootManifest, electronManifest, tauriConfig, orchestratorSource] = await Promise.all([
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'apps/electron/package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'apps/tauri/src-tauri/tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'scripts/release-packaging.mjs'), 'utf8'),
  ]);
  assert.equal(APP_IDENTIFIER, 'com.ineedfull.mqtt-tool');
  assert.equal(electronManifest.version, rootManifest.version);
  assert.equal(tauriConfig.version, rootManifest.version);
  assert.equal(electronManifest.build.appId, APP_IDENTIFIER);
  assert.equal(tauriConfig.identifier, APP_IDENTIFIER);
  assert.match(electronManifest.build.electronVersion, /^\d+\.\d+\.\d+$/u);
  assert.equal(electronManifest.build.afterPack, '../../scripts/release-packaging.mjs');
  // Chromium derives the macOS helper path from this internal bundle name.
  // The displayed brand may differ, but helper filenames must use the same case.
  assert.equal(electronManifest.build.mac.extendInfo.CFBundleName, electronManifest.build.productName);
  assert.doesNotMatch(orchestratorSource, /--config\.publish=null/u);
});

test('verifier requires exactly one artifact per runtime with one version and build time', async (t) => {
  const root = await temporaryDirectory(t);
  const target = hostReleaseTarget({ platform: 'darwin', arch: 'arm64' });
  const version = '0.1.0';
  const buildTime = '20260724T030405Z';
  const inspected = [];

  for (const runtime of ['electron', 'tauri']) {
    const directory = path.join(root, 'artifacts', runtime);
    const name = releaseArtifactName({ runtime, version, buildTime, target });
    const contents = Buffer.from(`${runtime}-artifact`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), contents);
    await writeFile(path.join(directory, releaseManifestName(target)), `${JSON.stringify({
      schemaVersion: 1,
      runtime,
      product: 'Ineed MQTT Tool',
      identifier: APP_IDENTIFIER,
      version,
      buildTime,
      platform: target.platform,
      architecture: target.architecture,
      artifact: { name, size: contents.length, sha256: sha256(contents) },
    })}\n`);
  }

  const result = await verifyReleasePackages({
    projectRoot: root,
    expectedVersion: version,
    target,
    inspectArtifact: async (artifactPath, context) => {
      inspected.push({ artifactPath, ...context });
      return { compiledRenderer: true, nativeRuntime: true, identifier: APP_IDENTIFIER };
    },
  });

  assert.equal(result.version, version);
  assert.equal(result.buildTime, buildTime);
  assert.deepEqual(result.runtimes, ['electron', 'tauri']);
  assert.equal(inspected.length, 2);
});

test('verifier requires every runtime artifact in the complete host platform matrix', async (t) => {
  const root = await temporaryDirectory(t);
  const targets = releaseTargetsForPlatform('darwin');
  const version = '0.1.0';
  const buildTime = '20260724T030405Z';
  const inspected = [];

  for (const target of targets) {
    for (const runtime of ['electron', 'tauri']) {
      await writeReleaseFixture({ root, runtime, version, buildTime, target });
    }
  }

  const result = await verifyReleasePackages({
    projectRoot: root,
    expectedVersion: version,
    targets,
    inspectArtifact: async (artifactPath, context) => {
      inspected.push({ artifactPath, ...context });
      return { compiledRenderer: true, nativeRuntime: true, identifier: APP_IDENTIFIER };
    },
  });

  assert.deepEqual(result.targets, [
    { platform: 'macos', architecture: 'arm64' },
    { platform: 'macos', architecture: 'x64' },
  ]);
  assert.deepEqual(result.runtimes, ['electron', 'tauri']);
  assert.equal(result.artifacts.length, 4);
  assert.equal(inspected.length, 4);
});

test('verifier identifies a missing runtime architecture from the host platform matrix', async (t) => {
  const root = await temporaryDirectory(t);
  const targets = releaseTargetsForPlatform('darwin');
  const version = '0.1.0';
  const buildTime = '20260724T030405Z';

  for (const target of targets) {
    for (const runtime of ['electron', 'tauri']) {
      if (runtime === 'tauri' && target.architecture === 'x64') continue;
      await writeReleaseFixture({ root, runtime, version, buildTime, target });
    }
  }

  await assert.rejects(
    verifyReleasePackages({
      projectRoot: root,
      expectedVersion: version,
      targets,
      inspectArtifact: async () => ({
        compiledRenderer: true,
        nativeRuntime: true,
        identifier: APP_IDENTIFIER,
      }),
    }),
    /missing tauri release manifest for macos-x64/i,
  );
});

test('verifier fails closed on stale collection files', async (t) => {
  const root = await temporaryDirectory(t);
  const target = hostReleaseTarget({ platform: 'darwin', arch: 'arm64' });
  const version = '0.1.0';
  const buildTime = '20260724T030405Z';

  for (const runtime of ['electron', 'tauri']) {
    const directory = path.join(root, 'artifacts', runtime);
    const name = releaseArtifactName({ runtime, version, buildTime, target });
    const contents = Buffer.from(`${runtime}-artifact`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), contents);
    await writeFile(path.join(directory, releaseManifestName(target)), `${JSON.stringify({
      schemaVersion: 1,
      runtime,
      product: 'Ineed MQTT Tool',
      identifier: APP_IDENTIFIER,
      version,
      buildTime,
      platform: target.platform,
      architecture: target.architecture,
      artifact: { name, size: contents.length, sha256: sha256(contents) },
    })}\n`);
  }
  await writeFile(path.join(root, 'artifacts', 'electron', 'stale.log'), 'stale');
  await assert.rejects(
    verifyReleasePackages({ projectRoot: root, expectedVersion: version, target, inspectArtifact: async () => ({
      compiledRenderer: true,
      nativeRuntime: true,
      identifier: APP_IDENTIFIER,
    }) }),
    /unexpected artifact collection entry/i,
  );
});

test('verifier fails closed on mismatched timestamps and changed bytes', async (t) => {
  const root = await temporaryDirectory(t);
  const target = hostReleaseTarget({ platform: 'darwin', arch: 'arm64' });
  const version = '0.1.0';
  const buildTime = '20260724T030405Z';
  const manifests = new Map();

  for (const runtime of ['electron', 'tauri']) {
    const directory = path.join(root, 'artifacts', runtime);
    const name = releaseArtifactName({ runtime, version, buildTime, target });
    const contents = Buffer.from(`${runtime}-artifact`);
    const manifest = {
      schemaVersion: 1,
      runtime,
      product: 'Ineed MQTT Tool',
      identifier: APP_IDENTIFIER,
      version,
      buildTime,
      platform: target.platform,
      architecture: target.architecture,
      artifact: { name, size: contents.length, sha256: sha256(contents) },
    };
    manifests.set(runtime, manifest);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), contents);
    await writeFile(path.join(directory, releaseManifestName(target)), `${JSON.stringify(manifest)}\n`);
  }
  const inspectArtifact = async () => ({
    compiledRenderer: true,
    nativeRuntime: true,
    identifier: APP_IDENTIFIER,
  });

  const tauriManifest = manifests.get('tauri');
  tauriManifest.buildTime = '20260724T030406Z';
  tauriManifest.artifact.name = releaseArtifactName({
    runtime: 'tauri',
    version,
    buildTime: tauriManifest.buildTime,
    target,
  });
  const oldPath = path.join(root, 'artifacts', 'tauri', releaseArtifactName({
    runtime: 'tauri', version, buildTime, target,
  }));
  const newPath = path.join(root, 'artifacts', 'tauri', tauriManifest.artifact.name);
  await writeFile(newPath, await readFile(oldPath));
  await rm(oldPath);
  await writeFile(
    path.join(root, 'artifacts', 'tauri', releaseManifestName(target)),
    `${JSON.stringify(tauriManifest)}\n`,
  );
  await assert.rejects(
    verifyReleasePackages({ projectRoot: root, expectedVersion: version, target, inspectArtifact }),
    /share one build timestamp/i,
  );

  tauriManifest.buildTime = buildTime;
  tauriManifest.artifact.name = path.basename(oldPath);
  await writeFile(oldPath, await readFile(newPath));
  await rm(newPath);
  await writeFile(
    path.join(root, 'artifacts', 'tauri', releaseManifestName(target)),
    `${JSON.stringify(tauriManifest)}\n`,
  );
  await writeFile(oldPath, 'changed-bytes');
  await assert.rejects(
    verifyReleasePackages({ projectRoot: root, expectedVersion: version, target, inspectArtifact }),
    /(?:size|SHA-256) differs/i,
  );
});
