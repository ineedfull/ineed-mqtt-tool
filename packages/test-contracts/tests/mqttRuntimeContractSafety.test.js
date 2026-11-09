import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import * as runtimeContract from '../../../tooling/mqtt-load-test/runtimeContract.mjs';
import * as tauriHarness from '../../../tooling/mqtt-load-test/tauriHarness.mjs';

const STATUS_FIELDS = [
  'status', 'source', 'code', 'reason', 'reconnected', 'attempt',
  'nextDelayMs', 'disconnectedAt',
];

test('every scenario declares an immutable exact expected projection', () => {
  assert.equal(typeof runtimeContract.EXPECTED_PROJECTIONS, 'object');
  assert.deepEqual(Object.keys(runtimeContract.EXPECTED_PROJECTIONS), [
    'plain-tcp-connect',
    'bad-credentials',
    'topic-filters',
    'unsubscribe-cancellation',
    'retained-late-subscribe',
    'binary-payload',
    'qos-boundaries',
    'clean-disconnect',
    'forced-drop-reconnect-resubscribe',
    'independent-connections',
  ]);
  for (const expected of Object.values(runtimeContract.EXPECTED_PROJECTIONS)) {
    assert.ok(Object.isFrozen(expected));
    for (const status of expected.statuses) {
      assert.deepEqual(Object.keys(status), STATUS_FIELDS);
    }
  }
  assert.deepEqual(runtimeContract.EXPECTED_PROJECTIONS['bad-credentials'].operations, [
    { operation: 'connect', result: { ok: false, code: 'AUTH_FAILED' } },
  ]);
});

test('a timed out scenario aborts, settles, prevents the next scenario, and cleans up once', async () => {
  assert.equal(typeof runtimeContract.runScenarioSequence, 'function');
  const starts = [];
  let staleTimerFired = false;
  let cleanups = 0;
  const startedAt = Date.now();

  await assert.rejects(runtimeContract.runScenarioSequence({
    names: ['hung', 'must-not-start'],
    timeoutMs: 25,
    settleTimeoutMs: 100,
    async execute(name, { signal }) {
      starts.push(name);
      const staleTimer = setTimeout(() => { staleTimerFired = true; }, 60);
      await new Promise(resolve => signal.addEventListener('abort', () => {
        clearTimeout(staleTimer);
        resolve();
      }, { once: true }));
    },
    async cleanup() { cleanups += 1; },
  }), /hung exceeded 25ms/u);

  await delay(80);
  assert.deepEqual(starts, ['hung']);
  assert.equal(staleTimerFired, false);
  assert.equal(cleanups, 1);
  assert.ok(Date.now() - startedAt < 500);
});

test('real Electron contract timeout preserves the scenario error and leaves no harness work', {
  timeout: 30_000,
}, async () => {
  let harness;
  let timeoutError;
  const startedAt = Date.now();
  try {
    await runtimeContract.runMqttRuntimeContract('electron', {
      scenarioTimeoutMs: 5,
      onRuntime(value) { harness = value; },
    });
    assert.fail('the 5ms production scenario must time out');
  } catch (error) {
    timeoutError = error;
  }

  assert.match(timeoutError.message, /^[a-z0-9-]+ exceeded 5ms$/u);
  assert.ok(Date.now() - startedAt < 1_000, `cleanup took ${Date.now() - startedAt}ms`);
  assert.deepEqual(harness.diagnostics, {
    trackedConnections: 0,
    pendingOperations: 0,
    pendingWaiters: 0,
  });

  const recovered = await runtimeContract.runMqttRuntimeContract('electron', {
    scenarioTimeoutMs: 10_000,
  });
  assert.equal(recovered.scenarios.length, 10);
  assert.ok(recovered.scenarios.every(scenario => scenario.outcome.ok));
});

test('byte NDJSON parser accepts split UTF-8 chunks and rejects an oversized line immediately', () => {
  assert.equal(typeof tauriHarness.createNdjsonParser, 'function');
  const values = [];
  const parser = tauriHarness.createNdjsonParser({
    maxLineBytes: 64,
    onValue: value => values.push(value),
  });
  const encoded = Buffer.from('{"text":"兼容"}\n{"ok":true}\n');
  parser.push(encoded.subarray(0, 10));
  parser.push(encoded.subarray(10, 13));
  parser.push(encoded.subarray(13));
  assert.deepEqual(values, [{ text: '兼容' }, { ok: true }]);
  assert.equal(parser.bufferedBytes, 0);

  const oversized = tauriHarness.createNdjsonParser({ maxLineBytes: 8, onValue() {} });
  assert.throws(() => oversized.push(Buffer.alloc(9, 0x61)), /stdout line exceeds 8 bytes/u);
  assert.ok(oversized.bufferedBytes <= 9);

  const invalidUtf8 = tauriHarness.createNdjsonParser({ maxLineBytes: 8, onValue() {} });
  assert.throws(() => invalidUtf8.push(Buffer.from([0xff, 0x0a])), /invalid UTF-8/u);
});

test('aborting a stalled Tauri request kills the child and a fresh harness still works', {
  timeout: 120_000,
}, async () => {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const port = server.address().port;
  const harness = await tauriHarness.createTauriHarness();
  const controller = new AbortController();
  const primary = new Error('primary Tauri abort');
  const connecting = harness.command('connect', {
    id: 'stalled', protocol: 'mqtt', host: '127.0.0.1', port,
    clientId: 'stalled-client', cleanSession: true, autoReconnect: false,
  }, { signal: controller.signal });
  const queued = harness.command('disconnect', 'queued');
  const waiting = harness.waitStatus(() => false, 4_000);
  const queuedRejection = assert.rejects(queued, error => error === primary);
  const waiterRejection = assert.rejects(waiting, error => error === primary);
  setTimeout(() => controller.abort(primary), 50);
  const startedAt = Date.now();
  await assert.rejects(connecting, error => error === primary);
  await queuedRejection;
  await waiterRejection;
  await assert.rejects(
    harness.command('disconnect', 'stalled'),
    /Rust MQTT harness terminated after request abort/u,
  );
  await harness.close();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(harness.diagnostics, {
    closed: true,
    pendingRequests: 0,
    pendingWaiters: 0,
  });
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));

  const recovered = await runtimeContract.runMqttRuntimeContract('tauri', {
    scenarioTimeoutMs: 10_000,
  });
  assert.equal(recovered.scenarios.length, 10);
});

test('stderr collector is byte bounded and preserves the first overflow error', () => {
  assert.equal(typeof tauriHarness.createBoundedTextCollector, 'function');
  const collector = tauriHarness.createBoundedTextCollector(8, 'stderr');
  collector.push(Buffer.from('1234'));
  collector.push(Buffer.from('5678'));
  const first = assert.throws(() => collector.push(Buffer.from('9')), /stderr exceeds 8 bytes/u);
  const second = assert.throws(() => collector.push(Buffer.from('again')), /stderr exceeds 8 bytes/u);
  assert.equal(second, first);
  assert.equal(Buffer.byteLength(collector.text), 8);
});

test('child output guard terminates once and preserves the original stdout or stderr bound error', () => {
  assert.equal(typeof tauriHarness.createChildOutputGuard, 'function');
  for (const stream of ['stdout', 'stderr']) {
    const terminations = [];
    const guard = tauriHarness.createChildOutputGuard({
      maxStdoutLineBytes: 8,
      maxStderrBytes: 8,
      onValue() {},
      terminate: error => terminations.push(error),
    });
    const feed = stream === 'stdout' ? guard.pushStdout : guard.pushStderr;
    feed(Buffer.alloc(9, 0x61));
    feed(Buffer.from('second overflow'));
    assert.equal(terminations.length, 1);
    assert.equal(guard.error, terminations[0]);
    assert.match(guard.error.message, new RegExp(`${stream} .*exceeds 8 bytes`, 'u'));
  }
});

test('Rust harness rejects over-limit input without newline quickly and with bounded RSS', {
  timeout: 120_000,
}, async () => {
  assert.equal(typeof tauriHarness.buildTauriHarness, 'function');
  const executable = await tauriHarness.buildTauriHarness();
  const timeArgs = process.platform === 'darwin' ? ['-l', executable] : ['-v', executable];
  const child = spawn('/usr/bin/time', timeArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.on('error', error => {
    if (error.code !== 'EPIPE') throw error;
  });
  const startedAt = Date.now();
  child.stdin.end(Buffer.alloc(4 * 1024 * 1024, 0x78));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const diagnostic = Buffer.concat(stderr).toString('utf8');
  const rssMatch = process.platform === 'darwin'
    ? diagnostic.match(/(\d+)\s+maximum resident set size/u)
    : diagnostic.match(/Maximum resident set size \(kbytes\):\s+(\d+)/u);
  assert.equal(code, 2);
  assert.match(diagnostic, /input exceeds 1048576 bytes/u);
  assert.ok(Date.now() - startedAt < 3_000);
  assert.ok(rssMatch, diagnostic);
  const rssBytes = Number(rssMatch[1]) * (process.platform === 'darwin' ? 1 : 1024);
  assert.ok(rssBytes < 128 * 1024 * 1024, `RSS ${rssBytes} exceeded 128 MiB`);
});
