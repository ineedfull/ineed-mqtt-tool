/* global process, URL */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { PNG } from 'pngjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(sortedValue(value));
}

function packageNameFromLockPath(lockPath) {
  const marker = '/node_modules/';
  return lockPath.includes(marker)
    ? lockPath.slice(lockPath.lastIndexOf(marker) + marker.length)
    : lockPath.slice('node_modules/'.length);
}

function resolveLockPackage(packages, ownerPath, dependencyName) {
  let searchPath = ownerPath;
  while (true) {
    const candidate = searchPath
      ? `${searchPath}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    const nestedAt = searchPath.lastIndexOf('/node_modules/');
    if (nestedAt === -1) {
      if (searchPath === '') return null;
      searchPath = '';
    } else {
      searchPath = searchPath.slice(0, nestedAt);
    }
  }
}

export function computeRendererDependencyIdentity(lockText) {
  const lock = JSON.parse(lockText);
  assert.equal(lock.lockfileVersion, 3, 'reference package-lock must use lockfileVersion 3');
  const packages = lock.packages;
  assert.ok(packages && typeof packages === 'object', 'reference package-lock packages are required');
  const root = packages[''];
  assert.ok(root && typeof root === 'object', 'reference package-lock root package is required');
  const pending = Object.keys(root.dependencies || {}).map(name => ({
    lockPath: resolveLockPackage(packages, '', name),
    optional: false,
  }));
  const visited = new Map();

  while (pending.length > 0) {
    const current = pending.pop();
    const { lockPath } = current;
    assert.ok(lockPath, 'reference renderer dependency is missing from package-lock');
    const entry = packages[lockPath];
    const optional = current.optional || entry.optional === true;
    if (visited.has(lockPath) && (visited.get(lockPath) === false || optional === true)) continue;
    visited.set(lockPath, optional);
    const addDependency = (dependencyName, dependencyOptional) => {
      const dependencyPath = resolveLockPackage(packages, lockPath, dependencyName);
      if (dependencyPath) pending.push({ lockPath: dependencyPath, optional: dependencyOptional });
      else if (!entry.peerDependenciesMeta?.[dependencyName]?.optional) {
        throw new Error(`${lockPath} dependency ${dependencyName} is missing from package-lock`);
      }
    };
    for (const dependencyName of Object.keys(entry.dependencies || {})) {
      addDependency(dependencyName, optional);
    }
    for (const dependencyName of Object.keys(entry.optionalDependencies || {})) {
      addDependency(dependencyName, true);
    }
    for (const dependencyName of Object.keys(entry.peerDependencies || {})) {
      addDependency(dependencyName, optional || entry.peerDependenciesMeta?.[dependencyName]?.optional === true);
    }
  }

  const closurePackages = [...visited.keys()].sort().map((lockPath) => {
    const entry = packages[lockPath];
    assert.equal(typeof entry.version, 'string', `${lockPath} version is required`);
    assert.equal(typeof entry.integrity, 'string', `${lockPath} integrity is required`);
    return {
      integrity: entry.integrity,
      lockPath,
      name: entry.name || packageNameFromLockPath(lockPath),
      optional: visited.get(lockPath),
      version: entry.version,
    };
  });
  const lockSha256 = sha256(lockText);
  return {
    closureSha256: sha256(canonicalJson({ lockSha256, packages: closurePackages })),
    lockSha256,
    packageCount: closurePackages.length,
    packages: closurePackages,
  };
}

export async function validateInstalledDependencyClosure({ identity, nodeModulesRoot }) {
  for (const dependency of identity.packages) {
    const relativePackageRoot = dependency.lockPath.slice('node_modules/'.length);
    const packagePath = path.join(nodeModulesRoot, relativePackageRoot, 'package.json');
    let installed;
    try {
      installed = JSON.parse(await readFile(packagePath, 'utf8'));
    } catch (error) {
      if (dependency.optional && error?.code === 'ENOENT') continue;
      throw new Error(`${dependency.name} ${dependency.version} is missing from reference node_modules`, { cause: error });
    }
    if (installed.name !== dependency.name || installed.version !== dependency.version) {
      throw new Error(
        `${dependency.name} expected ${dependency.version} in reference node_modules, found ${installed.name || '<unknown>'} ${installed.version || '<unknown>'}`,
      );
    }
  }
  return true;
}

async function listFiles(directory, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(relativeDirectory, entry.name);
    return entry.isDirectory()
      ? listFiles(path.join(directory, entry.name), relative)
      : [relative];
  }));
  return files.flat().sort();
}

export async function verifyManagedReferenceFixture({ expected = {}, fixtureRoot }) {
  const metadataContents = await readFile(path.join(fixtureRoot, 'metadata.json'));
  const metadata = JSON.parse(metadataContents);
  assert.equal(metadata.version, 1, 'managed reference metadata version differs');
  assert.match(metadata.source?.manifestSha256 || '', /^[0-9a-f]{64}$/u, 'managed reference source manifest hash is invalid');
  assert.match(metadata.dependencies?.lockSha256 || '', /^[0-9a-f]{64}$/u, 'managed reference lock hash is invalid');
  assert.match(metadata.dependencies?.closureSha256 || '', /^[0-9a-f]{64}$/u, 'managed reference dependency hash is invalid');
  if (expected.sourceManifestSha256) {
    assert.equal(metadata.source.manifestSha256, expected.sourceManifestSha256, 'managed reference source manifest hash differs');
  }
  if (expected.dependencyClosureSha256) {
    assert.equal(metadata.dependencies.closureSha256, expected.dependencyClosureSha256, 'managed reference dependency closure hash differs');
  }
  const artifactPaths = metadata.artifacts.map(artifact => artifact.path);
  assert.deepEqual(
    (await listFiles(fixtureRoot)).filter(file => file !== 'metadata.json'),
    [...artifactPaths].sort(),
    'managed reference artifact file set differs',
  );
  for (const artifact of metadata.artifacts) {
    const contents = await readFile(path.join(fixtureRoot, artifact.path));
    assert.equal(sha256(contents), artifact.sha256, `managed reference artifact ${artifact.path} hash differs`);
    assert.equal(contents.length, artifact.size, `managed reference artifact ${artifact.path} size differs`);
  }
  return { metadata, metadataSha256: sha256(metadataContents) };
}

export async function verifyReferenceBuildMatchesManagedFixture({ buildRoot, metadata }) {
  const artifactPaths = metadata.artifacts.map(artifact => artifact.path);
  assert.deepEqual(await listFiles(buildRoot), [...artifactPaths].sort(), 'fresh reference build artifact file set differs');
  for (const artifact of metadata.artifacts) {
    const contents = await readFile(path.join(buildRoot, artifact.path));
    assert.equal(sha256(contents), artifact.sha256, `fresh reference artifact ${artifact.path} hash differs`);
    assert.equal(contents.length, artifact.size, `fresh reference artifact ${artifact.path} size differs`);
  }
  return true;
}

export async function verifyVisualFontFixture({ fontRoot }) {
  const metadataContents = await readFile(path.join(fontRoot, 'metadata.json'));
  const metadata = JSON.parse(metadataContents);
  assert.equal(metadata.version, 1, 'visual font metadata version differs');
  assert.equal(metadata.license, 'SIL Open Font License 1.1', 'visual font license differs');
  assert.equal(metadata.fonts?.ui?.family, 'Visual Noto Sans SC', 'visual UI font family differs');
  assert.equal(metadata.fonts?.mono?.family, 'Visual Roboto Mono', 'visual mono font family differs');
  const assetFiles = metadata.assets.map(asset => asset.file);
  assert.deepEqual(
    (await listFiles(fontRoot)).filter(file => file !== 'metadata.json'),
    [...assetFiles].sort(),
    'visual font asset file set differs',
  );
  for (const asset of metadata.assets) {
    const contents = await readFile(path.join(fontRoot, asset.file));
    assert.equal(sha256(contents), asset.sha256, `visual font asset ${asset.file} hash differs`);
  }
  const css = metadata.assets.some(asset => asset.file === 'font.css')
    ? await readFile(path.join(fontRoot, 'font.css'), 'utf8')
    : null;
  return { css, metadata, metadataSha256: sha256(metadataContents) };
}

function visualFontCss(metadata) {
  const ui = metadata.fonts.ui;
  const mono = metadata.fonts.mono;
  return `
    @font-face {
      font-family: "${ui.family}";
      src: url("/__visual_fonts/${ui.file}") format("woff2");
      font-style: normal;
      font-weight: 100 900;
      font-display: block;
    }
    @font-face {
      font-family: "${mono.family}";
      src: url("/__visual_fonts/${mono.file}") format("woff2");
      font-style: normal;
      font-weight: 100 900;
      font-display: block;
    }
    html, body, button, input, select, textarea {
      font-family: "${ui.family}" !important;
    }
    code, pre, kbd, samp, .cm-editor, .cm-editor * {
      font-family: "${mono.family}" !important;
    }
  `;
}

export function createVisualFontPlugin({ css, fontRoot, metadata }) {
  const assets = new Set(metadata.assets.filter(asset => asset.file.endsWith('.woff2')).map(asset => asset.file));
  return {
    name: 'mqtt-visual-font-fixture',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        const prefix = '/__visual_fonts/';
        if (!url.pathname.startsWith(prefix)) return next();
        const file = decodeURIComponent(url.pathname.slice(prefix.length));
        if (!assets.has(file)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        try {
          const contents = await readFile(path.join(fontRoot, file));
          response.statusCode = 200;
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Type', 'font/woff2');
          response.end(contents);
        } catch (error) {
          next(error);
        }
      });
    },
    transformIndexHtml(html) {
      return html.replace('</head>', `<style data-visual-fonts>${css || visualFontCss(metadata)}</style></head>`);
    },
  };
}

export function computeVisualConfigHash(contract) {
  return sha256(canonicalJson(contract));
}

function expectedScreenshotPath(state, source) {
  return state === 'main-messages' ? `${source}.png` : `${state}/${source}.png`;
}

function assertExactKeys(value, expected, label) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys differ`);
}

function assertPng(contents, record, viewport) {
  const png = PNG.sync.read(contents);
  assert.equal(png.width, record.width, 'screenshot width differs from evidence');
  assert.equal(png.height, record.height, 'screenshot height differs from evidence');
  assert.equal(png.width, viewport.width, 'screenshot width differs from capture config');
  assert.equal(png.height, viewport.height, 'screenshot height differs from capture config');
  let opaque = 0;
  const colors = new Set();
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (png.data[offset + 3] === 255) opaque += 1;
    colors.add(`${png.data[offset]},${png.data[offset + 1]},${png.data[offset + 2]},${png.data[offset + 3]}`);
  }
  assert.equal(opaque, png.width * png.height, 'screenshot contains transparent pixels');
  assert.ok(colors.size > 1, 'screenshot is blank');
}

export async function validateVisualEvidence({ contract, evidenceRoot }) {
  try {
    const evidence = JSON.parse(await readFile(path.join(evidenceRoot, 'visual-parity.json'), 'utf8'));
    assertExactKeys(evidence, [
      'browser',
      'capture',
      'configSha256',
      'fonts',
      'masks',
      'metrics',
      'reference',
      'screenshots',
      'sources',
      'states',
      'threshold',
      'version',
    ], 'visual evidence schema');
    assert.equal(evidence.version, 2, 'visual evidence schema version differs');
    assertExactKeys(evidence.browser, ['name', 'platform', 'version'], 'visual evidence browser');
    assert.equal(evidence.browser.name, 'chromium', 'visual evidence browser name differs');
    assert.ok(typeof evidence.browser.platform === 'string' && evidence.browser.platform.length > 0, 'visual evidence browser platform is invalid');
    assert.ok(typeof evidence.browser.version === 'string' && evidence.browser.version.length > 0, 'visual evidence browser version is invalid');
    assert.deepEqual(evidence.states, contract.states, 'visual evidence states differ');
    assert.deepEqual(evidence.sources, contract.sources, 'visual evidence sources differ');
    for (const field of ['capture', 'fonts', 'masks', 'reference', 'threshold']) {
      assert.deepEqual(evidence[field], contract[field], `visual evidence ${field} differs`);
    }
    assert.equal(evidence.configSha256, computeVisualConfigHash(contract), 'visual evidence config hash differs');
    assertExactKeys(evidence.screenshots, contract.states, 'visual evidence screenshot states');
    assertExactKeys(evidence.metrics, contract.states, 'visual evidence metric states');
    for (const state of contract.states) {
      const metric = evidence.metrics[state];
      assertExactKeys(metric, ['boxes', 'pixels'], `${state} metrics`);
      assertExactKeys(metric.boxes, [
        'electronTauriMaxDeltaPx',
        'referenceElectronMaxDeltaPx',
        'referenceTauriMaxDeltaPx',
      ], `${state} box metrics`);
      assertExactKeys(metric.pixels, [
        'electronTauri',
        'referenceElectron',
        'referenceTauri',
      ], `${state} pixel metrics`);
      for (const value of Object.values(metric.boxes)) {
        assert.ok(Number.isFinite(value) && value >= 0, `${state} box metric is invalid`);
      }
      for (const comparison of Object.values(metric.pixels)) {
        assertExactKeys(comparison, ['diffPercent', 'diffPixels'], `${state} pixel comparison`);
        assert.ok(Number.isInteger(comparison.diffPixels) && comparison.diffPixels >= 0, `${state} diff pixels are invalid`);
        assert.ok(Number.isFinite(comparison.diffPercent) && comparison.diffPercent >= 0, `${state} diff percent is invalid`);
      }
      assertExactKeys(evidence.screenshots[state], contract.sources, `${state} screenshot sources`);
      for (const source of contract.sources) {
        const record = evidence.screenshots[state][source];
        assertExactKeys(record, ['height', 'path', 'sha256', 'width'], `${state}/${source} screenshot record`);
        const relativePath = expectedScreenshotPath(state, source);
        assert.equal(record.path, relativePath, `${state}/${source} screenshot path differs`);
        assert.match(record.sha256, /^[0-9a-f]{64}$/u, `${state}/${source} screenshot SHA is invalid`);
        const contents = await readFile(path.join(evidenceRoot, relativePath));
        assert.equal(sha256(contents), record.sha256, `${state}/${source} screenshot SHA differs`);
        assertPng(contents, record, contract.capture.viewport);
      }
    }
    return evidence;
  } catch (error) {
    throw new Error(`visual evidence validation failed: ${error.message}`, { cause: error });
  }
}

export function assertVisualMetricsMatch(committedMetrics, freshMetrics) {
  assert.deepEqual(freshMetrics, committedMetrics, 'fresh capture metrics differ from committed evidence');
}

export async function writeFileSynced(destination, contents) {
  await mkdir(path.dirname(destination), { recursive: true });
  const handle = await open(destination, 'w');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

function flattenedErrors(error) {
  return error instanceof AggregateError ? error.errors : [error];
}

function aggregate(primary, cleanupErrors, message) {
  return new AggregateError(
    [primary, ...cleanupErrors.flatMap(flattenedErrors)],
    message,
    { cause: primary },
  );
}

export async function replaceVisualEvidenceTransactionally({
  evidence,
  operations = {},
  screenshotRoot,
  screenshots,
  validateStaging,
}) {
  const token = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const parent = path.dirname(screenshotRoot);
  const base = path.basename(screenshotRoot);
  const staging = path.join(parent, `${base}.staging-${token}`);
  const backup = path.join(parent, `${base}.backup-${token}`);
  const move = operations.rename || rename;
  const remove = operations.rm || (target => rm(target, { force: true, recursive: true }));
  const writeSynced = operations.writeFileSynced || writeFileSynced;
  const sync = operations.syncDirectory || syncDirectory;
  let backupContainsOldEvidence = false;
  let currentContainsNewEvidence = false;
  let installCommitted = false;
  let stagingContainsNewEvidence = false;

  try {
    await mkdir(staging, { recursive: false });
    stagingContainsNewEvidence = true;
    for (const [relativePath, contents] of [...screenshots].sort(([left], [right]) => left.localeCompare(right))) {
      await writeSynced(path.join(staging, relativePath), contents);
    }
    await writeSynced(path.join(staging, 'visual-parity.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await validateStaging(staging);
    await sync(staging);
    await move(screenshotRoot, backup);
    backupContainsOldEvidence = true;
    await move(staging, screenshotRoot);
    stagingContainsNewEvidence = false;
    currentContainsNewEvidence = true;
    await sync(parent);
    installCommitted = true;
    await remove(backup);
    backupContainsOldEvidence = false;
  } catch (primary) {
    if (installCommitted) {
      throw aggregate(
        primary,
        [new Error(
          `The new visual evidence is committed at ${screenshotRoot}. A partial old backup may remain at ${backup}; inspect and remove that backup manually.`,
        )],
        `Visual evidence committed, but backup cleanup failed at ${backup}`,
      );
    }
    const cleanupErrors = [];
    if (currentContainsNewEvidence) {
      try {
        await move(screenshotRoot, staging);
        currentContainsNewEvidence = false;
        stagingContainsNewEvidence = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (backupContainsOldEvidence && !currentContainsNewEvidence) {
      try {
        await move(backup, screenshotRoot);
        backupContainsOldEvidence = false;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (stagingContainsNewEvidence) {
      try {
        await remove(staging);
        stagingContainsNewEvidence = false;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (backupContainsOldEvidence) {
      cleanupErrors.push(new Error(
        `Old visual evidence was preserved at ${backup}. Clear ${screenshotRoot}, then move ${backup} to ${screenshotRoot}.`,
      ));
    }
    if (cleanupErrors.length > 0) {
      throw aggregate(
        primary,
        cleanupErrors,
        backupContainsOldEvidence
          ? `Visual evidence rollback requires manual recovery from ${backup}`
          : 'Visual evidence update and rollback failed',
      );
    }
    throw primary;
  }
}

export async function runWithVisualCleanup(operation, cleanup) {
  let result;
  let primary;
  try {
    result = await operation();
  } catch (error) {
    primary = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (primary) throw aggregate(primary, [cleanupError], 'Visual operation and cleanup failed');
    throw cleanupError;
  }
  if (primary) throw primary;
  return result;
}
