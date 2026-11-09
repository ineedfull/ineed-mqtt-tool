import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as captureSupport from '../e2e/support/captureReference.mjs';

class FakeHttpServer extends EventEmitter {
  constructor({ listenError = null, port = 43123 } = {}) {
    super();
    this.active = false;
    this.closeCalls = 0;
    this.listenError = listenError;
    this.port = port;
  }

  address() {
    return this.active ? { address: '127.0.0.1', family: 'IPv4', port: this.port } : null;
  }

  close(callback) {
    this.closeCalls += 1;
    this.active = false;
    queueMicrotask(() => callback?.());
  }

  listen(_port, _host, callback) {
    this.active = true;
    queueMicrotask(() => {
      if (this.listenError) {
        this.active = false;
        this.emit('error', this.listenError);
        return;
      }
      callback();
    });
    return this;
  }
}

function fakeVite({ closeError = null } = {}) {
  return {
    closeCalls: 0,
    middlewares() {},
    async close() {
      this.closeCalls += 1;
      if (closeError) throw closeError;
    },
  };
}

test('listen failure closes the locally owned Vite server once and leaves no active handle', async () => {
  assert.equal(typeof captureSupport.startManagedViteServer, 'function');
  const vite = fakeVite();
  const http = new FakeHttpServer({ listenError: new Error('injected listen failure') });

  await assert.rejects(
    () => captureSupport.startManagedViteServer({
      createHttpServer: () => http,
      createViteServer: async () => vite,
      viteOptions: { root: '/fixture' },
    }),
    /injected listen failure/,
  );

  assert.equal(vite.closeCalls, 1);
  assert.equal(http.closeCalls, 1);
  assert.equal(http.active, false);
});

test('cleanup failure is aggregated after every server, browser, temp, and integrity phase runs', async () => {
  assert.equal(typeof captureSupport.cleanupVisualResources, 'function');
  const calls = [];
  const closeFailure = new Error('injected close failure');

  await assert.rejects(
    () => captureSupport.cleanupVisualResources({
      browsers: [{ async close() { calls.push('browser'); } }],
      removeTemporaryRoot: async root => calls.push(`remove:${root}`),
      servers: [
        { async close() { calls.push('server-1'); throw closeFailure; } },
        { async close() { calls.push('server-2'); } },
      ],
      temporaryRoot: '/tmp/owned-visual-fixture',
      verifyReferenceIntegrity: async () => calls.push('integrity'),
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(closeFailure));
      return true;
    },
  );

  assert.deepEqual(calls, [
    'server-1',
    'server-2',
    'browser',
    'remove:/tmp/owned-visual-fixture',
    'integrity',
  ]);
});

test('preview listen failure closes Vite once, removes temp, and leaves no active handle', async () => {
  const previewUrl = new URL('../e2e/support/serveTargetPreview.mjs', import.meta.url);
  const previewSource = await readFile(previewUrl, 'utf8');
  assert.match(previewSource, /export async function startTargetPreview/u);
  const { startTargetPreview } = await import(previewUrl);
  const calls = [];
  const vite = fakeVite();
  const http = new FakeHttpServer({ listenError: new Error('preview listen failure') });

  await assert.rejects(
    () => startTargetPreview({
      createHttpServer: () => http,
      createViteServer: async () => vite,
      makeTemporaryRoot: async () => '/tmp/owned-preview-fixture',
      removeTemporaryRoot: async root => calls.push(`remove:${root}`),
      repoRoot: '/repo',
    }),
    /preview listen failure/,
  );

  assert.equal(vite.closeCalls, 1);
  assert.equal(http.closeCalls, 1);
  assert.equal(http.active, false);
  assert.deepEqual(calls, ['remove:/tmp/owned-preview-fixture']);
});
