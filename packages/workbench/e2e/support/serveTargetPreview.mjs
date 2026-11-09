/* global process, URL */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpNodeServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

import {
  cleanupVisualResources,
  startManagedViteServer,
} from './captureReference.mjs';

const defaultRepoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const virtualEntry = '\0mqtt-target-visual-preview';

function previewPlugin(repoRoot) {
  const fixturePath = path.join(repoRoot, 'packages/workbench/e2e/fixtures/previewAdapter.js');
  const rendererPath = path.join(repoRoot, 'apps/electron/renderer/main.js');
  return {
    enforce: 'post',
    load(id) {
      if (id !== virtualEntry) return null;
      return `import { installBrowserFixture } from ${JSON.stringify(fixturePath)};\ninstallBrowserFixture();\nawait import(${JSON.stringify(rendererPath)});`;
    },
    name: 'mqtt-target-visual-preview',
    resolveId(id) {
      return id === '/@mqtt-target-visual-preview' ? virtualEntry : null;
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace('/renderer/main.js', '/@mqtt-target-visual-preview');
      },
    },
  };
}

function withCleanupFailure(primary, cleanupError) {
  const cleanupErrors = cleanupError instanceof AggregateError
    ? cleanupError.errors
    : [cleanupError];
  return new AggregateError(
    [primary, ...cleanupErrors],
    'Target preview startup and cleanup failed',
    { cause: primary },
  );
}

export async function startTargetPreview({
  createHttpServer = createHttpNodeServer,
  createViteServer = createServer,
  makeTemporaryRoot = prefix => mkdtemp(prefix),
  removeTemporaryRoot = root => rm(root, { force: true, recursive: true }),
  repoRoot = defaultRepoRoot,
  startServer = startManagedViteServer,
} = {}) {
  let temporaryRoot;
  let server;
  let startupComplete = false;
  let startupError;
  let cleanupError;
  let preview;
  try {
    temporaryRoot = await makeTemporaryRoot(path.join(tmpdir(), 'mqtt-target-preview-'));
    server = await startServer({
      createHttpServer,
      createViteServer,
      viteOptions: {
        cacheDir: temporaryRoot,
        configFile: path.join(repoRoot, 'apps/electron/vite.config.js'),
        plugins: [previewPlugin(repoRoot)],
        root: path.join(repoRoot, 'apps/electron'),
      },
    });
    let closePromise;
    startupComplete = true;
    preview = {
      close() {
        closePromise ||= cleanupVisualResources({
          removeTemporaryRoot,
          servers: [server],
          temporaryRoot,
        });
        return closePromise;
      },
      server,
      temporaryRoot,
      url: `${server.url}?visualRuntime=electron`,
    };
  } catch (primary) {
    startupError = primary;
  } finally {
    if (!startupComplete) {
      try {
        await cleanupVisualResources({
          removeTemporaryRoot,
          servers: server ? [server] : [],
          temporaryRoot,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (startupError) {
    if (cleanupError) throw withCleanupFailure(startupError, cleanupError);
    throw startupError;
  }
  return preview;
}

function errorText(error) {
  return error?.stack || error?.message || String(error);
}

export async function runTargetPreviewCli(options = {}) {
  const preview = await startTargetPreview(options);
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  stdout.write(`${preview.url}\n`);
  let signalReceived = false;
  const onSignal = () => {
    if (signalReceived) return;
    signalReceived = true;
    void preview.close().then(
      () => process.exit(0),
      (error) => {
        stderr.write(`${errorText(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return preview;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void runTargetPreviewCli().catch((error) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
