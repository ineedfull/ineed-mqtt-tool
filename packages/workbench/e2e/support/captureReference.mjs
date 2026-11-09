/* global process */

import { createHash } from 'node:crypto';
import { access, cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { createServer as createHttpNodeServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createServer } from 'vite';

import {
  assertVisualMetricsMatch,
  computeRendererDependencyIdentity,
  computeVisualConfigHash,
  createVisualFontPlugin,
  replaceVisualEvidenceTransactionally,
  runWithVisualCleanup,
  validateInstalledDependencyClosure,
  validateVisualEvidence,
  verifyManagedReferenceFixture,
  verifyReferenceBuildMatchesManagedFixture,
  verifyVisualFontFixture,
  writeFileSynced,
} from './visualInfrastructure.mjs';

export {
  assertVisualMetricsMatch,
  computeRendererDependencyIdentity,
  computeVisualConfigHash,
  createVisualFontPlugin,
  replaceVisualEvidenceTransactionally,
  runWithVisualCleanup,
  validateInstalledDependencyClosure,
  validateVisualEvidence,
  verifyManagedReferenceFixture,
  verifyReferenceBuildMatchesManagedFixture,
  verifyVisualFontFixture,
  writeFileSynced,
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function listReferenceFiles(directory, relativeDirectory = '') {
  const excluded = new Set(['.git', '.vite', 'cache', 'dist', 'node_modules', 'release']);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    if (excluded.has(entry.name)) return [];
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? listReferenceFiles(absolutePath, relativePath)
      : [relativePath];
  }));
  return files.flat().sort();
}

export async function verifyReferenceManifest(referenceRoot, manifestPath) {
  const manifest = await readFile(manifestPath, 'utf8');
  const entries = manifest.trim().split('\n').map((line) => {
    const match = line.match(/^([0-9a-f]{64}) {2}\.\/(.+)$/);
    if (!match) throw new Error(`Invalid Electron reference manifest entry: ${line}`);
    return { digest: match[1], relativePath: match[2] };
  });
  const expectedFiles = entries.map(entry => entry.relativePath).sort();
  const actualFiles = await listReferenceFiles(referenceRoot);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Electron reference source file set does not match its manifest');
  }

  for (const entry of entries) {
    const contents = await readFile(path.join(referenceRoot, entry.relativePath));
    const actual = sha256(contents);
    if (actual !== entry.digest) {
      throw new Error(`Electron reference source drift: ${entry.relativePath}`);
    }
  }

  return {
    entryCount: entries.length,
    manifestSha256: sha256(manifest),
  };
}

function runNpm(sourceRoot, args) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: sourceRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(' ')} failed with ${signal || `exit ${code}`}`));
    });
  });
}

export async function prepareExactReferenceCopy({
  dependencyIdentity,
  installDependencies = runNpm,
  manifestPath,
  referenceRoot,
  temporaryRoot,
}) {
  await verifyReferenceManifest(referenceRoot, manifestPath);
  const destination = path.join(temporaryRoot, 'current-electron-source');
  await cp(referenceRoot, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(referenceRoot, source);
      const firstSegment = relative.split(path.sep)[0];
      return !['.git', '.vite', 'cache', 'dist', 'node_modules', 'release'].includes(firstSegment);
    },
  });
  await verifyReferenceManifest(destination, manifestPath);

  let dependencyMode = 'verified-reference-node-modules';
  const referenceNodeModules = path.join(referenceRoot, 'node_modules');
  try {
    await validateInstalledDependencyClosure({
      identity: dependencyIdentity,
      nodeModulesRoot: referenceNodeModules,
    });
    await symlink(
      referenceNodeModules,
      path.join(destination, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch {
    dependencyMode = 'temporary-npm-ci';
    await installDependencies(destination, ['ci', '--ignore-scripts']);
  }
  await validateInstalledDependencyClosure({
    identity: dependencyIdentity,
    nodeModulesRoot: path.join(destination, 'node_modules'),
  });
  await verifyReferenceManifest(destination, manifestPath);
  return {
    dependencyIdentity,
    dependencyMode,
    sourceRoot: destination,
  };
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    } catch (error) {
      if (error?.code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    }
  });
}

function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    try {
      server.listen(0, '127.0.0.1', onListening);
    } catch (error) {
      server.off('error', onError);
      reject(error);
    }
  });
}

function errorsFrom(error) {
  return error instanceof AggregateError ? error.errors : [error];
}

function primaryWithCleanupErrors(primary, cleanupError, message) {
  return new AggregateError(
    [primary, ...errorsFrom(cleanupError)],
    message,
    { cause: primary },
  );
}

async function closeAll(resources, errors) {
  for (const resource of resources) {
    try {
      await resource.close();
    } catch (error) {
      errors.push(...errorsFrom(error));
    }
  }
}

export async function cleanupVisualResources({
  browsers = [],
  removeTemporaryRoot = root => rm(root, { force: true, recursive: true }),
  servers = [],
  temporaryRoot,
  verifyReferenceIntegrity = async () => {},
}) {
  const errors = [];
  await closeAll(servers, errors);
  await closeAll(browsers, errors);
  if (temporaryRoot) {
    try {
      await removeTemporaryRoot(temporaryRoot);
    } catch (error) {
      errors.push(...errorsFrom(error));
    }
  }
  try {
    await verifyReferenceIntegrity();
  } catch (error) {
    errors.push(...errorsFrom(error));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Visual resource cleanup failed');
  }
}

export async function startManagedViteServer({
  createHttpServer = createHttpNodeServer,
  createViteServer = createServer,
  viteOptions,
}) {
  let viteServer;
  let httpServer;
  try {
    httpServer = createHttpServer((request, response) => {
      if (!viteServer) {
        response.statusCode = 503;
        response.end('Renderer server is starting');
        return;
      }
      viteServer.middlewares(request, response);
    });
    viteServer = await createViteServer({
      ...viteOptions,
      server: {
        ...viteOptions?.server,
        middlewareMode: true,
        ws: { server: httpServer },
      },
    });
    await listenOnRandomPort(httpServer);
    const address = httpServer.address();
    if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
      throw new Error('HTTP renderer server did not expose an actual port');
    }
    let closePromise;
    return {
      httpServer,
      url: `http://127.0.0.1:${address.port}/`,
      viteServer,
      close() {
        closePromise ||= cleanupVisualResources({
          servers: [
            viteServer,
            { close: () => closeHttpServer(httpServer) },
          ],
        });
        return closePromise;
      },
    };
  } catch (primary) {
    try {
      await cleanupVisualResources({
        servers: [
          ...(viteServer ? [viteServer] : []),
          ...(httpServer ? [{ close: () => closeHttpServer(httpServer) }] : []),
        ],
      });
    } catch (cleanupError) {
      throw primaryWithCleanupErrors(
        primary,
        cleanupError,
        'Renderer startup and cleanup failed',
      );
    }
    throw primary;
  }
}

export async function startVisualRendererServers({
  dependencies = {},
  referenceRoot = process.env.VISUAL_REFERENCE_ROOT || null,
  repoRoot,
}) {
  const verifyReference = dependencies.verifyReferenceManifest || verifyReferenceManifest;
  const makeTemporaryRoot = dependencies.makeTemporaryRoot || (prefix => mkdtemp(prefix));
  const removeTemporaryRoot = dependencies.removeTemporaryRoot || (root => rm(root, { force: true, recursive: true }));
  const prepareReference = dependencies.prepareExactReferenceCopy || prepareExactReferenceCopy;
  const executeNpm = dependencies.runNpm || runNpm;
  const startServer = dependencies.startManagedViteServer || startManagedViteServer;
  const manifestPath = path.join(repoRoot, 'docs/verification/reference-manifests/electron.sha256');
  const managedFixtureRoot = path.join(repoRoot, 'packages/workbench/e2e/fixtures/reference-renderer');
  const fontRoot = path.join(repoRoot, 'packages/workbench/e2e/fixtures/fonts');
  const servers = [];
  let temporaryRoot;

  try {
    const manifestContents = await readFile(manifestPath, 'utf8');
    const referenceManifest = {
      entryCount: manifestContents.trim().split('\n').length,
      manifestSha256: sha256(manifestContents),
    };
    const managedFixture = await verifyManagedReferenceFixture({
      expected: { sourceManifestSha256: referenceManifest.manifestSha256 },
      fixtureRoot: managedFixtureRoot,
    });
    const fonts = await verifyVisualFontFixture({ fontRoot });
    temporaryRoot = await makeTemporaryRoot(path.join(tmpdir(), 'mqtt-visual-parity-'));
    let referenceRendererRoot = managedFixtureRoot;
    let referenceMode = 'managed-reference-fixture';

    if (referenceRoot) {
      let externalManifestMatches = false;
      try {
        await access(referenceRoot);
        const externalManifest = await verifyReference(referenceRoot, manifestPath);
        externalManifestMatches = externalManifest.manifestSha256 === referenceManifest.manifestSha256;
      } catch {
        externalManifestMatches = false;
      }
      if (externalManifestMatches) {
        const dependencyIdentity = computeRendererDependencyIdentity(
          await readFile(path.join(referenceRoot, 'package-lock.json'), 'utf8'),
        );
        if (dependencyIdentity.closureSha256 !== managedFixture.metadata.dependencies.closureSha256) {
          throw new Error('External reference renderer dependency closure differs from managed fixture');
        }
        if (dependencyIdentity.lockSha256 !== managedFixture.metadata.dependencies.lockSha256) {
          throw new Error('External reference package-lock differs from managed fixture');
        }
        const prepared = await prepareReference({
          dependencyIdentity,
          manifestPath,
          referenceRoot,
          temporaryRoot,
        });
        const freshBuildRoot = path.join(temporaryRoot, 'fresh-reference-build');
        await executeNpm(prepared.sourceRoot, [
          'run',
          'build',
          '--',
          '--outDir',
          freshBuildRoot,
          '--emptyOutDir',
        ]);
        await verifyReferenceBuildMatchesManagedFixture({
          buildRoot: freshBuildRoot,
          metadata: managedFixture.metadata,
        });
        referenceRendererRoot = freshBuildRoot;
        referenceMode = `external-fresh-build:${prepared.dependencyMode}`;
      }
    }

    const fontPlugin = () => createVisualFontPlugin({
      css: fonts.css,
      fontRoot,
      metadata: fonts.metadata,
    });
    const reference = await startServer({
      viteOptions: {
        cacheDir: path.join(temporaryRoot, 'cache-reference'),
        configFile: false,
        plugins: [fontPlugin()],
        root: referenceRendererRoot,
      },
    });
    servers.push(reference);

    const electron = await startServer({
      viteOptions: {
        cacheDir: path.join(temporaryRoot, 'cache-electron'),
        configFile: path.join(repoRoot, 'apps/electron/vite.config.js'),
        plugins: [fontPlugin()],
        root: path.join(repoRoot, 'apps/electron'),
      },
    });
    servers.push(electron);

    const tauri = await startServer({
      viteOptions: {
        cacheDir: path.join(temporaryRoot, 'cache-tauri'),
        configFile: path.join(repoRoot, 'apps/tauri/vite.config.js'),
        plugins: [fontPlugin()],
        root: path.join(repoRoot, 'apps/tauri'),
      },
    });
    servers.push(tauri);
    let closePromise;

    return {
      fonts,
      managedFixture,
      referenceMode,
      referenceManifest,
      sources: [
        { id: 'current-electron', runtime: 'reference', source: 'managed-reference-renderer', url: reference.url },
        { id: 'monorepo-electron', runtime: 'electron', source: 'apps/electron', url: electron.url },
        { id: 'monorepo-tauri', runtime: 'tauri', source: 'apps/tauri', url: tauri.url },
      ],
      close() {
        closePromise ||= cleanupVisualResources({
          removeTemporaryRoot,
          servers,
          temporaryRoot,
          verifyReferenceIntegrity: async () => {
            await verifyManagedReferenceFixture({
              expected: { sourceManifestSha256: referenceManifest.manifestSha256 },
              fixtureRoot: managedFixtureRoot,
            });
            await verifyVisualFontFixture({ fontRoot });
            if (referenceRoot && referenceMode.startsWith('external-fresh-build:')) {
              await verifyReference(referenceRoot, manifestPath);
            }
          },
        });
        return closePromise;
      },
    };
  } catch (primary) {
    try {
      await cleanupVisualResources({
        removeTemporaryRoot,
        servers,
        temporaryRoot,
        verifyReferenceIntegrity: async () => {
          await verifyManagedReferenceFixture({ fixtureRoot: managedFixtureRoot });
          await verifyVisualFontFixture({ fontRoot });
        },
      });
    } catch (cleanupError) {
      throw primaryWithCleanupErrors(
        primary,
        cleanupError,
        'Visual renderer startup and cleanup failed',
      );
    }
    throw primary;
  }
}
