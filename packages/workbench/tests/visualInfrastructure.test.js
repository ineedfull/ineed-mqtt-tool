import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PNG } from 'pngjs';

import * as visualSupport from '../e2e/support/captureReference.mjs';

const STATE_IDS = [
  'main-messages',
  'logs',
  'connection-dialog',
  'settings',
  'message-history',
  'log-history',
];
const SOURCE_IDS = ['current-electron', 'monorepo-electron', 'monorepo-tauri'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tinyPng(red = 40) {
  const png = new PNG({ height: 2, width: 2 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = red + offset;
    png.data[offset + 1] = 80 + offset;
    png.data[offset + 2] = 120 + offset;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function treeHash(root) {
  const entries = [];
  async function walk(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryRelative = path.posix.join(relative, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, entryRelative);
      else entries.push(`${entryRelative}\0${sha256(await readFile(absolute))}`);
    }
  }
  await walk(root);
  return sha256(entries.join('\n'));
}

function expectedContract() {
  return {
    capture: {
      colorScheme: 'light',
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      viewport: { height: 2, width: 2 },
    },
    fonts: {
      metadataSha256: 'f'.repeat(64),
      monoFamily: 'Visual Roboto Mono',
      uiFamily: 'Visual Noto Sans SC',
    },
    masks: [],
    reference: {
      dependencyClosureSha256: 'd'.repeat(64),
      managedFixtureMetadataSha256: 'b'.repeat(64),
      manifestSha256: 'a'.repeat(64),
    },
    sources: SOURCE_IDS,
    states: STATE_IDS,
    threshold: {
      boundingBoxMaxDeltaPx: 2,
      electronTauriDiffPixels: 0,
      pixelmatch: 0.1,
      referenceDiffPercentMax: 0.5,
    },
  };
}

async function writeEvidenceFixture(root) {
  const contract = expectedContract();
  const screenshots = {};
  for (const state of STATE_IDS) {
    screenshots[state] = {};
    for (const source of SOURCE_IDS) {
      const relative = state === 'main-messages' ? `${source}.png` : `${state}/${source}.png`;
      const contents = tinyPng(state.charCodeAt(0));
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), contents);
      screenshots[state][source] = {
        height: 2,
        path: relative,
        sha256: sha256(contents),
        width: 2,
      };
    }
  }
  const evidence = {
    version: 2,
    browser: { name: 'chromium', platform: 'test', version: '1' },
    ...contract,
    configSha256: visualSupport.computeVisualConfigHash?.(contract) || 'missing',
    metrics: Object.fromEntries(STATE_IDS.map(state => [state, {
      boxes: {
        electronTauriMaxDeltaPx: 0,
        referenceElectronMaxDeltaPx: 0,
        referenceTauriMaxDeltaPx: 0,
      },
      pixels: {
        electronTauri: { diffPercent: 0, diffPixels: 0 },
        referenceElectron: { diffPercent: 0, diffPixels: 0 },
        referenceTauri: { diffPercent: 0, diffPixels: 0 },
      },
    }])),
    screenshots,
  };
  await writeFile(path.join(root, 'visual-parity.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return { contract, evidence };
}

test('renderer dependency identity follows the reference lock closure only', () => {
  assert.equal(typeof visualSupport.computeRendererDependencyIdentity, 'function');
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { alpha: '^1.0.0' } },
      'node_modules/alpha': {
        dependencies: { beta: '^2.0.0' },
        integrity: 'sha512-alpha',
        name: 'alpha',
        version: '1.0.1',
      },
      'node_modules/beta': { integrity: 'sha512-beta', name: 'beta', version: '2.0.3' },
      'node_modules/dev-only': { integrity: 'sha512-dev', name: 'dev-only', version: '9.9.9' },
    },
  };
  const lockText = `${JSON.stringify(lock, null, 2)}\n`;
  const identity = visualSupport.computeRendererDependencyIdentity(lockText);

  assert.equal(identity.lockSha256, sha256(lockText));
  assert.deepEqual(identity.packages, [
    { integrity: 'sha512-alpha', lockPath: 'node_modules/alpha', name: 'alpha', optional: false, version: '1.0.1' },
    { integrity: 'sha512-beta', lockPath: 'node_modules/beta', name: 'beta', optional: false, version: '2.0.3' },
  ]);
  assert.match(identity.closureSha256, /^[0-9a-f]{64}$/u);
});

test('platform optional lock branches remain hashed but may be absent from npm ci output', async (t) => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { alpha: '1.0.0' } },
      'node_modules/alpha': {
        integrity: 'sha512-alpha',
        name: 'alpha',
        optionalDependencies: { platform: '1.0.0' },
        version: '1.0.0',
      },
      'node_modules/platform': {
        cpu: ['wasm32'],
        integrity: 'sha512-platform',
        name: 'platform',
        optional: true,
        version: '1.0.0',
      },
    },
  };
  const identity = visualSupport.computeRendererDependencyIdentity(JSON.stringify(lock));
  assert.equal(identity.packages.find(item => item.name === 'platform').optional, true);
  const root = await mkdtemp(path.join(tmpdir(), 'mqtt-optional-closure-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, 'alpha'), { recursive: true });
  await writeFile(path.join(root, 'alpha/package.json'), '{"name":"alpha","version":"1.0.0"}\n');
  await visualSupport.validateInstalledDependencyClosure({ identity, nodeModulesRoot: root });
});

test('installed dependency validation requires every reference lock closure version', async (t) => {
  assert.equal(typeof visualSupport.validateInstalledDependencyClosure, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'mqtt-reference-node-modules-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const identity = {
    packages: [
      { integrity: 'sha512-alpha', lockPath: 'node_modules/alpha', name: 'alpha', version: '1.0.1' },
      { integrity: 'sha512-beta', lockPath: 'node_modules/alpha/node_modules/beta', name: 'beta', version: '2.0.3' },
    ],
  };
  for (const dependency of identity.packages) {
    const packageRoot = path.join(root, dependency.lockPath.slice('node_modules/'.length));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: dependency.name,
      version: dependency.version,
    }));
  }

  await visualSupport.validateInstalledDependencyClosure({ identity, nodeModulesRoot: root });
  await writeFile(
    path.join(root, 'alpha/node_modules/beta/package.json'),
    JSON.stringify({ name: 'beta', version: '2.0.4' }),
  );
  await assert.rejects(
    () => visualSupport.validateInstalledDependencyClosure({ identity, nodeModulesRoot: root }),
    /beta.*2\.0\.3.*2\.0\.4/iu,
  );
});

test('reference copy uses only exact reference dependencies and revalidates copied source', async (t) => {
  assert.equal(typeof visualSupport.prepareExactReferenceCopy, 'function');
  const parent = await mkdtemp(path.join(tmpdir(), 'mqtt-exact-reference-copy-'));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const referenceRoot = path.join(parent, 'reference');
  const temporaryRoot = path.join(parent, 'temporary');
  const manifestPath = path.join(parent, 'electron.sha256');
  await mkdir(path.join(referenceRoot, 'node_modules/alpha'), { recursive: true });
  await mkdir(temporaryRoot);
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { alpha: '1.0.1' } },
      'node_modules/alpha': { integrity: 'sha512-alpha', name: 'alpha', version: '1.0.1' },
    },
  };
  const files = new Map([
    ['index.html', '<div id="app"></div>\n'],
    ['package-lock.json', `${JSON.stringify(lock, null, 2)}\n`],
    ['package.json', '{"name":"reference"}\n'],
  ]);
  for (const [relative, contents] of files) await writeFile(path.join(referenceRoot, relative), contents);
  await writeFile(
    path.join(referenceRoot, 'node_modules/alpha/package.json'),
    '{"name":"alpha","version":"1.0.1"}\n',
  );
  await writeFile(
    manifestPath,
    [...files].sort(([left], [right]) => left.localeCompare(right))
      .map(([relative, contents]) => `${sha256(contents)}  ./${relative}`)
      .join('\n') + '\n',
  );
  const identity = visualSupport.computeRendererDependencyIdentity(files.get('package-lock.json'));
  let installCalls = 0;
  const prepared = await visualSupport.prepareExactReferenceCopy({
    dependencyIdentity: identity,
    installDependencies: async () => { installCalls += 1; },
    manifestPath,
    referenceRoot,
    temporaryRoot,
  });

  assert.equal(installCalls, 0);
  assert.equal(
    await readlink(path.join(prepared.sourceRoot, 'node_modules')),
    path.join(referenceRoot, 'node_modules'),
  );
  assert.equal(prepared.dependencyMode, 'verified-reference-node-modules');
  await visualSupport.verifyReferenceManifest(prepared.sourceRoot, manifestPath);
});

test('reference copy installs exact lock dependencies inside temp when reference modules drift', async (t) => {
  assert.equal(typeof visualSupport.prepareExactReferenceCopy, 'function');
  const parent = await mkdtemp(path.join(tmpdir(), 'mqtt-reference-npm-ci-'));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const referenceRoot = path.join(parent, 'reference');
  const temporaryRoot = path.join(parent, 'temporary');
  const manifestPath = path.join(parent, 'electron.sha256');
  await mkdir(path.join(referenceRoot, 'node_modules/alpha'), { recursive: true });
  await mkdir(temporaryRoot);
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { alpha: '1.0.1' } },
      'node_modules/alpha': { integrity: 'sha512-alpha', name: 'alpha', version: '1.0.1' },
    },
  };
  const lockText = `${JSON.stringify(lock, null, 2)}\n`;
  const sourceFiles = new Map([
    ['package-lock.json', lockText],
    ['package.json', '{"name":"reference"}\n'],
  ]);
  for (const [relative, contents] of sourceFiles) await writeFile(path.join(referenceRoot, relative), contents);
  await writeFile(path.join(referenceRoot, 'node_modules/alpha/package.json'), '{"name":"alpha","version":"9.0.0"}\n');
  await writeFile(
    manifestPath,
    [...sourceFiles].sort(([left], [right]) => left.localeCompare(right))
      .map(([relative, contents]) => `${sha256(contents)}  ./${relative}`)
      .join('\n') + '\n',
  );
  const calls = [];
  const prepared = await visualSupport.prepareExactReferenceCopy({
    dependencyIdentity: visualSupport.computeRendererDependencyIdentity(lockText),
    installDependencies: async (sourceRoot, args) => {
      calls.push({ args, sourceRoot });
      await mkdir(path.join(sourceRoot, 'node_modules/alpha'), { recursive: true });
      await writeFile(path.join(sourceRoot, 'node_modules/alpha/package.json'), '{"name":"alpha","version":"1.0.1"}\n');
    },
    manifestPath,
    referenceRoot,
    temporaryRoot,
  });

  assert.deepEqual(calls, [{ args: ['ci', '--ignore-scripts'], sourceRoot: prepared.sourceRoot }]);
  assert.equal(prepared.dependencyMode, 'temporary-npm-ci');
  await visualSupport.validateInstalledDependencyClosure({
    identity: prepared.dependencyIdentity,
    nodeModulesRoot: path.join(prepared.sourceRoot, 'node_modules'),
  });
});

test('managed reference fixture verifies source, dependencies, and every artifact hash', async (t) => {
  assert.equal(typeof visualSupport.verifyManagedReferenceFixture, 'function');
  assert.equal(typeof visualSupport.verifyReferenceBuildMatchesManagedFixture, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'mqtt-managed-reference-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const html = Buffer.from('<!doctype html><div id="app"></div>');
  const script = Buffer.from('console.log("reference")\n');
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'index.html'), html);
  await writeFile(path.join(root, 'assets/reference.js'), script);
  const metadata = {
    version: 1,
    artifacts: [
      { path: 'assets/reference.js', sha256: sha256(script), size: script.length },
      { path: 'index.html', sha256: sha256(html), size: html.length },
    ],
    dependencies: {
      closureSha256: 'd'.repeat(64),
      lockSha256: 'c'.repeat(64),
      packageCount: 2,
    },
    source: { entryCount: 3, manifestSha256: 'a'.repeat(64) },
  };
  await writeFile(path.join(root, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);

  const verified = await visualSupport.verifyManagedReferenceFixture({
    expected: {
      dependencyClosureSha256: metadata.dependencies.closureSha256,
      sourceManifestSha256: metadata.source.manifestSha256,
    },
    fixtureRoot: root,
  });
  assert.equal(verified.metadata.version, 1);
  assert.match(verified.metadataSha256, /^[0-9a-f]{64}$/u);
  const freshRoot = path.join(root, '..', `${path.basename(root)}-fresh`);
  t.after(() => rm(freshRoot, { force: true, recursive: true }));
  await mkdir(path.join(freshRoot, 'assets'), { recursive: true });
  await writeFile(path.join(freshRoot, 'index.html'), html);
  await writeFile(path.join(freshRoot, 'assets/reference.js'), script);
  await visualSupport.verifyReferenceBuildMatchesManagedFixture({
    buildRoot: freshRoot,
    metadata: verified.metadata,
  });

  await writeFile(path.join(root, 'assets/reference.js'), 'tampered\n');
  await assert.rejects(
    () => visualSupport.verifyManagedReferenceFixture({ fixtureRoot: root }),
    /artifact.*reference\.js.*hash/iu,
  );
});

test('font fixture verifies assets and exposes one deterministic Vite route and CSS contract', async (t) => {
  assert.equal(typeof visualSupport.verifyVisualFontFixture, 'function');
  assert.equal(typeof visualSupport.createVisualFontPlugin, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'mqtt-visual-fonts-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const ui = Buffer.from('ui-woff2');
  const mono = Buffer.from('mono-woff2');
  const license = Buffer.from('SIL Open Font License\n');
  await writeFile(path.join(root, 'ui.woff2'), ui);
  await writeFile(path.join(root, 'mono.woff2'), mono);
  await writeFile(path.join(root, 'OFL.txt'), license);
  const metadata = {
    version: 1,
    assets: [
      { file: 'ui.woff2', sha256: sha256(ui) },
      { file: 'mono.woff2', sha256: sha256(mono) },
      { file: 'OFL.txt', sha256: sha256(license) },
    ],
    fonts: {
      mono: { family: 'Visual Roboto Mono', file: 'mono.woff2' },
      ui: { family: 'Visual Noto Sans SC', file: 'ui.woff2' },
    },
    license: 'SIL Open Font License 1.1',
  };
  await writeFile(path.join(root, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);

  const verified = await visualSupport.verifyVisualFontFixture({ fontRoot: root });
  const plugin = visualSupport.createVisualFontPlugin({ fontRoot: root, metadata: verified.metadata });
  const html = plugin.transformIndexHtml('<html><head></head><body></body></html>');
  assert.match(html, /@font-face/u);
  assert.match(html, /Visual Noto Sans SC/u);
  assert.match(html, /Visual Roboto Mono/u);
  assert.match(html, /\/__visual_fonts\/ui\.woff2/u);
  let middleware;
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  const chunks = [];
  const response = {
    end(chunk) { if (chunk) chunks.push(chunk); },
    setHeader() {},
  };
  await middleware({ url: '/__visual_fonts/ui.woff2' }, response, () => assert.fail('font route fell through'));
  assert.deepEqual(Buffer.concat(chunks), ui);
});

test('committed evidence rejects screenshot SHA, capture config, and reference identity tampering', async (t) => {
  assert.equal(typeof visualSupport.validateVisualEvidence, 'function');
  assert.equal(typeof visualSupport.computeVisualConfigHash, 'function');
  const root = await mkdtemp(path.join(tmpdir(), 'mqtt-evidence-validation-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const { contract, evidence } = await writeEvidenceFixture(root);

  await visualSupport.validateVisualEvidence({ contract, evidenceRoot: root });

  for (const mutate of [
    value => { value.unexpected = true; },
    value => { value.screenshots.logs['current-electron'].sha256 = '0'.repeat(64); },
    value => { value.capture.deviceScaleFactor = 2; },
    value => { value.reference.manifestSha256 = '1'.repeat(64); },
  ]) {
    const tampered = structuredClone(evidence);
    mutate(tampered);
    await writeFile(path.join(root, 'visual-parity.json'), `${JSON.stringify(tampered, null, 2)}\n`);
    await assert.rejects(
      () => visualSupport.validateVisualEvidence({ contract, evidenceRoot: root }),
      /visual evidence|screenshot|config|reference/iu,
    );
  }
});

test('ordinary visual metrics reject committed diff pixel, percent, and box delta tampering', () => {
  assert.equal(typeof visualSupport.assertVisualMetricsMatch, 'function');
  const committed = {
    'main-messages': {
      boxes: {
        electronTauriMaxDeltaPx: 0,
        referenceElectronMaxDeltaPx: 0,
        referenceTauriMaxDeltaPx: 0,
      },
      pixels: {
        electronTauri: { diffPercent: 0, diffPixels: 0 },
        referenceElectron: { diffPercent: 0.001, diffPixels: 10 },
        referenceTauri: { diffPercent: 0.001, diffPixels: 10 },
      },
    },
  };
  for (const mutate of [
    metrics => { metrics['main-messages'].pixels.referenceElectron.diffPixels += 1; },
    metrics => { metrics['main-messages'].pixels.referenceTauri.diffPercent += 0.001; },
    metrics => { metrics['main-messages'].boxes.referenceElectronMaxDeltaPx += 1; },
  ]) {
    const tampered = structuredClone(committed);
    mutate(tampered);
    assert.throws(
      () => visualSupport.assertVisualMetricsMatch(tampered, committed),
      /fresh capture metrics differ/iu,
    );
  }
});

for (const failurePoint of ['png', 'json', 'rename']) {
  test(`transactional evidence update preserves the old tree on ${failurePoint} failure`, async (t) => {
    assert.equal(typeof visualSupport.replaceVisualEvidenceTransactionally, 'function');
    const parent = await mkdtemp(path.join(tmpdir(), 'mqtt-evidence-transaction-'));
    t.after(() => rm(parent, { force: true, recursive: true }));
    const current = path.join(parent, 'screenshots');
    await mkdir(current);
    await writeFile(path.join(current, 'old.txt'), 'old evidence\n');
    const before = await treeHash(current);
    const writes = new Map([
      ['a.png', tinyPng(10)],
      ['b.png', tinyPng(20)],
    ]);
    let writeCount = 0;
    let renameCount = 0;
    const realWriteSynced = visualSupport.writeFileSynced;
    const realRename = (from, to) => import('node:fs/promises').then(fs => fs.rename(from, to));

    await assert.rejects(
      () => visualSupport.replaceVisualEvidenceTransactionally({
        evidence: { version: 2 },
        screenshotRoot: current,
        screenshots: writes,
        validateStaging: async () => {},
        operations: {
          rename: async (from, to) => {
            renameCount += 1;
            if (failurePoint === 'rename' && renameCount === 2) throw new Error('injected rename failure');
            await realRename(from, to);
          },
          writeFileSynced: async (destination, contents) => {
            writeCount += 1;
            if (failurePoint === 'png' && writeCount === 2) throw new Error('injected PNG failure');
            if (failurePoint === 'json' && destination.endsWith('visual-parity.json')) throw new Error('injected JSON failure');
            await realWriteSynced(destination, contents);
          },
        },
      }),
      /injected/,
    );

    assert.equal(await treeHash(current), before);
    assert.deepEqual(
      (await readdir(parent)).filter(name => name.includes('.staging-') || name.includes('.backup-')),
      [],
    );
  });
}

test('rollback preserves the only old backup when parent sync and rollback rename both fail', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'mqtt-evidence-double-failure-'));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const current = path.join(parent, 'screenshots');
  await mkdir(current);
  await writeFile(path.join(current, 'old.txt'), 'irreplaceable old evidence\n');
  const oldTreeHash = await treeHash(current);
  const realRename = (from, to) => import('node:fs/promises').then(fs => fs.rename(from, to));
  let renameCount = 0;
  let syncCount = 0;
  let failure;

  try {
    await visualSupport.replaceVisualEvidenceTransactionally({
      evidence: { version: 2 },
      screenshotRoot: current,
      screenshots: new Map([['new.png', tinyPng(90)]]),
      validateStaging: async () => {},
      operations: {
        rename: async (from, to) => {
          renameCount += 1;
          if (renameCount === 3) throw new Error('injected rollback rename failure');
          await realRename(from, to);
        },
        syncDirectory: async () => {
          syncCount += 1;
          if (syncCount === 2) throw new Error('injected post-install parent sync failure');
        },
      },
    });
    assert.fail('transaction unexpectedly succeeded');
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof AggregateError);
  assert.ok(failure.errors.some(error => error.message === 'injected post-install parent sync failure'));
  assert.ok(failure.errors.some(error => error.message === 'injected rollback rename failure'));
  const backups = (await readdir(parent)).filter(name => name.includes('.backup-'));
  assert.equal(backups.length, 1, 'the only old baseline backup must be retained');
  const backupPath = path.join(parent, backups[0]);
  assert.equal(await treeHash(backupPath), oldTreeHash);
  assert.match(failure.message, new RegExp(backupPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('committed update preserves new current when backup removal partially succeeds then fails', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'mqtt-evidence-post-commit-cleanup-'));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const current = path.join(parent, 'screenshots');
  const expectedNew = path.join(parent, 'expected-new');
  const evidence = { version: 2 };
  const screenshot = tinyPng(120);
  await mkdir(current);
  await writeFile(path.join(current, 'old-a.txt'), 'old evidence A\n');
  await writeFile(path.join(current, 'old-b.txt'), 'old evidence B\n');
  await mkdir(expectedNew);
  await writeFile(path.join(expectedNew, 'new.png'), screenshot);
  await writeFile(path.join(expectedNew, 'visual-parity.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const expectedNewHash = await treeHash(expectedNew);
  let failure;

  try {
    await visualSupport.replaceVisualEvidenceTransactionally({
      evidence,
      screenshotRoot: current,
      screenshots: new Map([['new.png', screenshot]]),
      validateStaging: async () => {},
      operations: {
        rm: async (target) => {
          if (target.includes('.backup-')) {
            await rm(path.join(target, 'old-a.txt'));
            throw new Error('injected partial backup cleanup failure');
          }
          await rm(target, { force: true, recursive: true });
        },
        syncDirectory: async () => {},
      },
    });
    assert.fail('transaction unexpectedly succeeded');
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof AggregateError);
  assert.ok(failure.errors.some(error => error.message === 'injected partial backup cleanup failure'));
  assert.equal(await treeHash(current), expectedNewHash, 'the committed new evidence must remain current');
  const backups = (await readdir(parent)).filter(name => name.includes('.backup-'));
  assert.equal(backups.length, 1, 'the partial old backup must remain for inspection');
  const backupPath = path.join(parent, backups[0]);
  assert.deepEqual(await readdir(backupPath), ['old-b.txt']);
  assert.match(failure.message, new RegExp(backupPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('visual operation failure aggregates a cleanup failure without losing either error', async () => {
  assert.equal(typeof visualSupport.runWithVisualCleanup, 'function');
  const primary = new Error('capture failed');
  const cleanup = new Error('cleanup failed');

  await assert.rejects(
    () => visualSupport.runWithVisualCleanup(
      async () => { throw primary; },
      async () => { throw cleanup; },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.equal(error.cause, primary);
      return true;
    },
  );
});
