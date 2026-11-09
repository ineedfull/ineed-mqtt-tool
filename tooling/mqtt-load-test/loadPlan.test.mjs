import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_LOAD_PLAN,
  LOAD_PROTOCOL_LIMITS,
  formatLoadHelp,
  loadProtocolBounds,
  parseLoadArgs,
  validateLoadPlan,
} from './loadPlan.mjs';
import {
  assertRecordProvenance,
  assertLoadPersistenceHealthy,
  createLoadPersistence,
  createMessageLedger,
  formatVerificationReport,
  makeLoadPayload,
  parsePsRss,
  parseWindowsWorkingSet,
  runLoadGate,
  runRuntimeLoad,
  runWithCleanup,
} from './loadRunner.mjs';
import * as loadRunnerModule from './loadRunner.mjs';
import * as tauriHarnessModule from './tauriHarness.mjs';

const { createTauriHarness } = tauriHarnessModule;

test('load plan defaults are exact and immutable', () => {
  assert.deepEqual(DEFAULT_LOAD_PLAN, {
    connections: 2,
    topicsPerConnection: 10,
    payloadBytes: 1_024,
    totalMessages: 10_000,
    nativeEventBatch: 200,
    persistenceBatch: 200,
    queueMax: 2_000,
    realtimeMaxPerConnection: 300,
    retryCount: 3,
    publishConcurrency: 16,
    publishRatePerSecond: 4_000,
    timeoutMs: 120_000,
    rssGrowthLimitBytes: 256 * 1_024 * 1_024,
  });
  assert.equal(Object.isFrozen(DEFAULT_LOAD_PLAN), true);
  assert.throws(() => { DEFAULT_LOAD_PLAN.connections = 3; }, TypeError);
});

test('CLI accepts strict integer overrides and LOAD_TOTAL_MESSAGES', () => {
  const parsed = parseLoadArgs([
    '--connections=4',
    '--topics-per-connection', '5',
    '--payload-bytes', '2048',
    '--publish-concurrency=8',
    '--record',
  ], { LOAD_TOTAL_MESSAGES: '200' });

  assert.equal(parsed.help, false);
  assert.equal(parsed.record, true);
  assert.equal(parsed.plan.connections, 4);
  assert.equal(parsed.plan.topicsPerConnection, 5);
  assert.equal(parsed.plan.payloadBytes, 2_048);
  assert.equal(parsed.plan.totalMessages, 200);
  assert.equal(parsed.plan.publishConcurrency, 8);
  assert.equal(Object.isFrozen(parsed.plan), true);
});

test('CLI rejects unknown, duplicate, non-finite, non-positive, unsafe, and non-divisible values', () => {
  const invalid = [
    ['--wat=1'],
    ['--connections=2', '--connections=3'],
    ['--connections=0'],
    ['--connections=-1'],
    ['--connections=NaN'],
    ['--connections=Infinity'],
    ['--connections=1.5'],
    ['--total-messages=9007199254740992'],
    ['--connections=2', '--topics-per-connection=3', '--total-messages=10'],
  ];
  for (const args of invalid) assert.throws(() => parseLoadArgs(args, {}), Error, args.join(' '));
  assert.throws(() => parseLoadArgs([], { LOAD_TOTAL_MESSAGES: '-1' }), /LOAD_TOTAL_MESSAGES/u);
});

test('protocol validation rejects undersized metadata and oversized payloads before runtime creation', async () => {
  assert.throws(() => parseLoadArgs(['--payload-bytes=64'], {}), /metadata/u);
  assert.throws(() => parseLoadArgs(['--payload-bytes=1048576'], {}), /payloadBytes/u);
  let runtimeStarts = 0;
  await assert.rejects(runLoadGate(
    { ...DEFAULT_LOAD_PLAN, payloadBytes: 64 },
    { runtimeRunner: async () => { runtimeStarts += 1; } },
  ), /metadata/u);
  assert.equal(runtimeStarts, 0);
});

test('protocol bounds enforce exact Rust stdin capacity and conservative stdout batch capacity', () => {
  const exactStdinPayload = Math.floor(
    (LOAD_PROTOCOL_LIMITS.rustStdinBytes - LOAD_PROTOCOL_LIMITS.commandEnvelopeBytes)
      / DEFAULT_LOAD_PLAN.persistenceBatch,
  ) - LOAD_PROTOCOL_LIMITS.persistenceRowOverheadBytes;
  const exactPlan = { ...DEFAULT_LOAD_PLAN, payloadBytes: exactStdinPayload };
  assert.doesNotThrow(() => validateLoadPlan(exactPlan));
  assert.equal(loadProtocolBounds(exactPlan).rustStdinBytes <= LOAD_PROTOCOL_LIMITS.rustStdinBytes, true);
  assert.throws(
    () => validateLoadPlan({ ...exactPlan, payloadBytes: exactStdinPayload + 1 }),
    /Rust stdin/u,
  );
  const maximumBounds = loadProtocolBounds({
    ...DEFAULT_LOAD_PLAN,
    payloadBytes: LOAD_PROTOCOL_LIMITS.payloadHardMaxBytes,
  });
  assert.ok(maximumBounds.rustStdoutBytes < LOAD_PROTOCOL_LIMITS.rustStdoutBytes);
});

test('help is a non-running action with bounded usage text', () => {
  const parsed = parseLoadArgs(['--help'], {});
  assert.deepEqual(parsed, { help: true, record: false, plan: DEFAULT_LOAD_PLAN });
  assert.match(formatLoadHelp(), /Usage: npm run test:load/u);
  assert.ok(formatLoadHelp().length < 4_000);
});

test('payload is exact-sized ASCII and carries a deterministic unique identity', () => {
  const payload = makeLoadPayload({
    payloadBytes: 1_024,
    runtime: 'electron',
    runId: 'run-1',
    connection: 1,
    topic: 7,
    sequence: 42,
  });
  assert.equal(payload.byteLength, 1_024);
  assert.match(payload.toString('ascii'), /^\{"id":"electron\/run-1\/c1\/t7\/s42"/u);
});

test('load runner imports production persistence and realtime modules without custom queue code', async () => {
  const source = await readFile(new URL('./loadRunner.mjs', import.meta.url), 'utf8');
  assert.match(source, /workspace\/batchedPersistence\.js/u);
  assert.match(source, /workspace\/realtimeItems\.js/u);
  assert.doesNotMatch(source, /function createPersistenceQueue/u);
});

test('message ledger validates exact totals and retains the last 300 per connection', () => {
  const plan = Object.freeze({ ...DEFAULT_LOAD_PLAN, connections: 1, topicsPerConnection: 1, totalMessages: 305 });
  const ledger = createMessageLedger({ plan, runtime: 'electron', runId: 'run-1' });
  for (let sequence = 0; sequence < 305; sequence += 1) {
    const payload = makeLoadPayload({ payloadBytes: plan.payloadBytes, runtime: 'electron', runId: 'run-1', connection: 0, topic: 0, sequence });
    ledger.recordBatch([{
      connId: 'load-run-1-c0', topic: 'load/run-1/c0/t0', payload,
      byteLength: payload.byteLength, qos: 1, retained: false,
    }]);
  }

  const result = ledger.finalize();
  assert.equal(result.received, 305);
  assert.equal(result.unique, 305);
  assert.equal(result.realtimeByConnection.get(0).length, 300);
  assert.match(result.realtimeByConnection.get(0)[0].id, /\/s5$/u);
  assert.match(result.realtimeByConnection.get(0).at(-1).id, /\/s304$/u);
});

test('message ledger fails duplicate, missing, and per-topic out-of-order traffic', () => {
  const plan = Object.freeze({ ...DEFAULT_LOAD_PLAN, connections: 1, topicsPerConnection: 1, totalMessages: 2 });
  const event = sequence => {
    const payload = makeLoadPayload({ payloadBytes: plan.payloadBytes, runtime: 'tauri', runId: 'run-2', connection: 0, topic: 0, sequence });
    return {
      connId: 'load-run-2-c0', topic: 'load/run-2/c0/t0', payload,
      byteLength: payload.byteLength, qos: 1, retained: false,
    };
  };
  const duplicate = createMessageLedger({ plan, runtime: 'tauri', runId: 'run-2' });
  duplicate.recordBatch([event(0)]);
  assert.throws(() => duplicate.recordBatch([event(0)]), /duplicate/u);

  const missing = createMessageLedger({ plan, runtime: 'tauri', runId: 'run-2' });
  missing.recordBatch([event(0)]);
  assert.throws(() => missing.finalize(), /missing/u);

  const unordered = createMessageLedger({ plan, runtime: 'tauri', runId: 'run-2' });
  assert.throws(() => unordered.recordBatch([event(1)]), /out-of-order/u);

  const wrongQos = createMessageLedger({ plan, runtime: 'tauri', runId: 'run-2' });
  assert.throws(() => wrongQos.recordBatch([{ ...event(0), qos: 0, retained: false }]), /QoS 1/u);
  const retained = createMessageLedger({ plan, runtime: 'tauri', runId: 'run-2' });
  assert.throws(() => retained.recordBatch([{ ...event(0), qos: 1, retained: true }]), /retained false/u);
});

test('production batched persistence retries twice then succeeds without dropping', async () => {
  let attempts = 0;
  const batches = [];
  const persistence = createLoadPersistence({
    plan: { ...DEFAULT_LOAD_PLAN, persistenceBatch: 2, queueMax: 4 },
    retryDelay: () => Promise.resolve(),
    async persistBatch(rows) {
      attempts += 1;
      if (attempts < 3) throw new Error('injected database failure');
      batches.push(rows);
    },
  });
  persistence.enqueueBatch([{ id: 1 }, { id: 2 }, { id: 3 }]);
  await persistence.flush();

  assert.deepEqual(batches.map(rows => rows.length), [2, 1]);
  assert.equal(persistence.metrics.retries, 2);
  assert.equal(persistence.metrics.droppedRows, 0);
  assert.equal(persistence.metrics.queueSize, 0);
  assert.equal(persistence.metrics.maxBatch, 2);
  assert.doesNotThrow(() => assertLoadPersistenceHealthy(persistence));
});

test('production batched persistence reports failure after initial attempt plus three retries', async () => {
  let attempts = 0;
  const persistence = createLoadPersistence({
    plan: { ...DEFAULT_LOAD_PLAN, persistenceBatch: 2, queueMax: 4 },
    retryDelay: () => Promise.resolve(),
    async persistBatch() { attempts += 1; throw new Error('permanent database failure'); },
  });
  persistence.enqueueBatch([{ id: 1 }]);
  await persistence.flush();
  assert.equal(attempts, 4);
  assert.equal(persistence.metrics.retries, 3);
  assert.equal(persistence.metrics.droppedRows, 1);
  assert.equal(persistence.metrics.queueSize, 0);
  assert.throws(() => assertLoadPersistenceHealthy(persistence), /persistence failed/u);
});

test('production batched persistence overflow calls onDrop and fails the gate', async () => {
  let releaseFirst;
  let calls = 0;
  const persistence = createLoadPersistence({
    plan: { ...DEFAULT_LOAD_PLAN, persistenceBatch: 2, queueMax: 2 },
    async persistBatch() {
      calls += 1;
      if (calls === 1) await new Promise(resolve => { releaseFirst = resolve; });
    },
  });
  persistence.enqueueBatch([{ id: 1 }, { id: 2 }]);
  await Promise.resolve();
  persistence.enqueueBatch([{ id: 3 }, { id: 4 }, { id: 5 }]);
  releaseFirst();
  await persistence.flush();
  assert.equal(persistence.metrics.droppedRows, 1);
  assert.equal(persistence.metrics.queueSize, 0);
  assert.throws(() => assertLoadPersistenceHealthy(persistence), /queue-overflow/u);
});

test('production queue peak counts the item that synchronously triggers the 200-row flush', async () => {
  const persistence = createLoadPersistence({
    plan: DEFAULT_LOAD_PLAN,
    persistBatch: async () => {},
  });
  persistence.enqueueBatch(Array.from({ length: 200 }, (_, id) => ({ id })));
  await persistence.flush();
  assert.equal(persistence.metrics.peakQueue, 200);
  assert.equal(persistence.metrics.maxBatch, 200);
});

test('RSS parsers return measured bytes or explicit null without inventing values', () => {
  assert.equal(parsePsRss(' 12345\n'), 12_641_280);
  assert.equal(parsePsRss('not available'), null);
  assert.equal(parseWindowsWorkingSet('987654321\r\n'), 987_654_321);
  assert.equal(parseWindowsWorkingSet('Process not found'), null);
});

test('Cargo manifest URL resolution decodes spaces, percent signs, and Windows drives', () => {
  assert.equal(typeof tauriHarnessModule.resolveCargoManifest, 'function');
  assert.equal(tauriHarnessModule.resolveCargoManifest(
    'file:///tmp/Repo%20Space/100%25/tooling/mqtt-load-test/tauriHarness.mjs',
    { windows: false },
  ), '/tmp/Repo Space/100%/apps/tauri/src-tauri/Cargo.toml');
  assert.equal(tauriHarnessModule.resolveCargoManifest(
    'file:///C:/Repo%20Space/100%25/tooling/mqtt-load-test/tauriHarness.mjs',
    { windows: true },
  ), 'C:\\Repo Space\\100%\\apps\\tauri\\src-tauri\\Cargo.toml');
});

test('Windows process-tree termination constructs taskkill and waits for close', async () => {
  assert.equal(typeof tauriHarnessModule.terminateProcessTree, 'function');
  const calls = [];
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const child = { pid: 4242, kill: signal => calls.push(['fallback', signal]) };
  await tauriHarnessModule.terminateProcessTree(child, closed, {
    platformName: 'win32',
    closeTimeoutMs: 25,
    execFileImpl(command, args, options, callback) {
      calls.push([command, args, options]);
      resolveClosed();
      callback(null);
    },
  });
  assert.deepEqual(calls, [[
    'taskkill', ['/PID', '4242', '/T', '/F'], { timeout: 25, windowsHide: true },
  ]]);
});

test('Windows taskkill error is contained by fallback but hard close still fails', async () => {
  assert.equal(typeof tauriHarnessModule.terminateProcessTree, 'function');
  const fallbackCalls = [];
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  await tauriHarnessModule.terminateProcessTree({
    pid: 4343,
    kill(signal) { fallbackCalls.push(signal); resolveClosed(); },
  }, closed, {
    platformName: 'win32',
    closeTimeoutMs: 25,
    execFileImpl(_command, _args, _options, callback) {
      callback(new Error('taskkill unavailable'));
    },
  });
  assert.deepEqual(fallbackCalls, ['SIGKILL']);

  await assert.rejects(tauriHarnessModule.terminateProcessTree({
    pid: 4444,
    kill() {},
  }, new Promise(() => {}), {
    platformName: 'win32',
    closeTimeoutMs: 5,
    execFileImpl(_command, _args, _options, callback) {
      callback(new Error('taskkill unavailable'));
    },
  }), /did not close within 5 ms.*taskkill failed: taskkill unavailable/iu);
});

test('POSIX process-tree termination signals the detached process group', async () => {
  assert.equal(typeof tauriHarnessModule.terminateProcessTree, 'function');
  const calls = [];
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  await tauriHarnessModule.terminateProcessTree({ pid: 4545, kill() {} }, closed, {
    platformName: 'linux',
    closeTimeoutMs: 25,
    killProcess(pid, signal) { calls.push([pid, signal]); resolveClosed(); },
  });
  assert.deepEqual(calls, [[-4545, 'SIGKILL']]);
});

test('Windows child RSS sampling uses PowerShell WorkingSet64 and returns parsed bytes', async () => {
  assert.equal(typeof loadRunnerModule.sampleChildRss, 'function');
  const calls = [];
  const value = await loadRunnerModule.sampleChildRss(4242, {
    platformName: 'win32',
    async execFileImpl(command, args, options) {
      calls.push([command, args, options]);
      return { stdout: '987654321\r\n' };
    },
  });
  assert.equal(value, 987_654_321);
  assert.deepEqual(calls, [[
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Id 4242 -ErrorAction Stop).WorkingSet64',
    ],
    { timeout: 2_000 },
  ]]);
});

test('supported child RSS errors and unsupported platforms fail closed', async () => {
  assert.equal(typeof loadRunnerModule.sampleChildRss, 'function');
  assert.equal(typeof loadRunnerModule.sampleRss, 'function');
  await assert.rejects(loadRunnerModule.sampleChildRss(4242, {
    platformName: 'darwin',
    async execFileImpl() { throw new Error('injected ps failure'); },
  }), /injected ps failure/u);
  await assert.rejects(loadRunnerModule.sampleChildRss(4242, {
    platformName: 'linux',
    async execFileImpl() { return { stdout: 'not-a-number' }; },
  }), /finite measured bytes/u);
  await assert.rejects(loadRunnerModule.sampleChildRss(4242, {
    platformName: 'freebsd',
    async execFileImpl() { throw new Error('must not execute'); },
  }), /unsupported.*RSS.*freebsd/iu);
  await assert.rejects(loadRunnerModule.sampleRss('electron', null, {
    platformName: 'freebsd',
    memoryUsage: () => ({ rss: 64 * 1_024 * 1_024 }),
  }), /unsupported.*RSS.*freebsd/iu);
});

function assertFailedLoadCleanup(cleanup) {
  assert.equal(cleanup.brokerClosed, true);
  assert.equal(cleanup.runtimeClosed, true);
  assert.equal(cleanup.openSockets, 0);
  assert.equal(cleanup.trackedConnections, 0);
  assert.equal(cleanup.pendingOperations, 0);
  assert.equal(cleanup.pendingWaiters, 0);
  assert.equal(cleanup.persistenceQueue, 0);
  assert.equal(cleanup.databaseClosed, true);
  assert.equal(cleanup.tempRemoved, true);
}

test('RSS baseline null fails the gate after complete runtime and temp cleanup', async () => {
  const plan = parseLoadArgs([
    '--total-messages=40', '--payload-bytes=256', '--publish-concurrency=4',
    '--publish-rate-per-second=2000', '--timeout-ms=90000',
  ], {}).plan;
  let cleanup;
  let temporary;
  await assert.rejects(runRuntimeLoad({
    runtime: 'electron',
    plan,
    signal: new AbortController().signal,
    rssSampler: async () => null,
    onReady(context) { temporary = context.temporary; },
    onCleanup(value) { cleanup = value; },
  }), /RSS baseline.*finite measured bytes/iu);
  assertFailedLoadCleanup(cleanup);
  await assert.rejects(access(temporary), { code: 'ENOENT' });
});

test('RSS baseline command rejection fails the gate after complete cleanup', async () => {
  const plan = parseLoadArgs([
    '--total-messages=40', '--payload-bytes=256', '--publish-concurrency=4',
    '--publish-rate-per-second=2000', '--timeout-ms=90000',
  ], {}).plan;
  let cleanup;
  await assert.rejects(runRuntimeLoad({
    runtime: 'electron',
    plan,
    signal: new AbortController().signal,
    rssSampler: async () => { throw new Error('injected RSS command failure'); },
    onCleanup(value) { cleanup = value; },
  }), /injected RSS command failure/u);
  assertFailedLoadCleanup(cleanup);
});

test('RSS final null fails before runtime close and still completes cleanup', async () => {
  const plan = parseLoadArgs([
    '--total-messages=40', '--payload-bytes=256', '--publish-concurrency=4',
    '--publish-rate-per-second=2000', '--timeout-ms=90000',
  ], {}).plan;
  let calls = 0;
  let cleanup;
  await assert.rejects(runRuntimeLoad({
    runtime: 'electron',
    plan,
    signal: new AbortController().signal,
    rssSampleIntervalMs: 60_000,
    rssSampler: async () => {
      calls += 1;
      return calls === 1 ? 64 * 1_024 * 1_024 : null;
    },
    onCleanup(value) { cleanup = value; },
  }), /final RSS sample.*finite measured bytes/iu);
  assert.equal(calls, 2);
  assertFailedLoadCleanup(cleanup);
});

test('late in-flight periodic RSS rejection is awaited and fails after complete cleanup', async () => {
  const plan = parseLoadArgs([
    '--total-messages=40', '--payload-bytes=256', '--publish-concurrency=4',
    '--publish-rate-per-second=2000', '--timeout-ms=90000',
  ], {}).plan;
  let calls = 0;
  let cleanup;
  let temporary;
  await assert.rejects(runRuntimeLoad({
    runtime: 'electron',
    plan,
    signal: new AbortController().signal,
    rssSampleIntervalMs: 1,
    rssSampler: async () => {
      calls += 1;
      if (calls === 1) return 64 * 1_024 * 1_024;
      if (calls === 2) {
        await new Promise(resolve => setTimeout(resolve, 75));
        throw new Error('injected late RSS failure');
      }
      return 65 * 1_024 * 1_024;
    },
    onReady(context) { temporary = context.temporary; },
    onCleanup(value) { cleanup = value; },
  }), /injected late RSS failure/u);
  assert.ok(calls >= 2);
  assertFailedLoadCleanup(cleanup);
  await assert.rejects(access(temporary), { code: 'ENOENT' });
});

test('record provenance rejects dirty trees and reports a clean implementation commit', async () => {
  await assert.rejects(
    assertRecordProvenance({ statusPorcelain: async () => ' M loadRunner.mjs', commit: async () => 'abc' }),
    /clean git worktree/u,
  );
  assert.deepEqual(await assertRecordProvenance({
    statusPorcelain: async () => '',
    commit: async () => 'abc123',
  }), { dirty: false, implementationCommit: 'abc123' });
});

test('verification report identifies Windows coverage as unit-only', () => {
  const markdown = formatVerificationReport({
    planSha256: 'plan-hash',
    plan: DEFAULT_LOAD_PLAN,
    sourceSha256: {},
    environment: {
      node: 'node', npm: 'npm', rust: 'rust', cargo: 'cargo',
      os: 'darwin', arch: 'arm64', dirty: false, implementationCommit: 'abc123',
    },
    runtimes: [],
    durationMs: 1,
  });
  assert.match(markdown, /Windows coverage:.*unit-tested/iu);
  assert.match(markdown, /Native Windows integration evidence requires a Windows run/iu);
});

test('abort path closes resources in reverse order and preserves the abort reason', async () => {
  const closed = [];
  const reason = new Error('overall timeout');
  const controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(runWithCleanup({
    signal: controller.signal,
    resources: [
      { close: async () => closed.push('temp') },
      { close: async () => closed.push('broker') },
      { close: async () => closed.push('runtime') },
      { close: async () => closed.push('database') },
    ],
    operation: async () => { throw controller.signal.reason; },
  }), error => error === reason);
  assert.deepEqual(closed, ['database', 'runtime', 'broker', 'temp']);
});

test('Tauri production database commands exercise shared retry success and terminal failure', {
  timeout: 120_000,
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'ineed-mqtt-load-db-test-'));
  const harness = await createTauriHarness();
  t.after(async () => {
    await harness.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const row = id => ({
    connection_id: 'fault-conn', topic: `fault/${id}`, payload: String(id),
    direction: 'in', qos: 0, retained: 0, format: 'text',
  });

  assert.equal((await harness.command('db_init', {
    databasePath: join(temporary, 'retry.db'), connectionIds: ['fault-conn'],
  })).ok, true);
  assert.equal((await harness.command('db_fail_next', { count: 2 })).ok, true);
  const recovered = createLoadPersistence({
    plan: { ...DEFAULT_LOAD_PLAN, persistenceBatch: 1, queueMax: 4 },
    retryDelay: () => Promise.resolve(),
    persistBatch: async rows => {
      const result = await harness.command('db_save_messages', { rows });
      if (!result.ok) throw new Error(result.error);
    },
  });
  recovered.enqueueBatch([row(1)]);
  await recovered.flush();
  assert.equal(recovered.metrics.retries, 2);
  assert.equal(recovered.metrics.droppedRows, 0);
  assert.equal((await harness.command('db_count')).count, 1);
  assertLoadPersistenceHealthy(recovered);

  assert.equal((await harness.command('db_fail_next', { count: 4 })).ok, true);
  const failed = createLoadPersistence({
    plan: { ...DEFAULT_LOAD_PLAN, persistenceBatch: 1, queueMax: 4 },
    retryDelay: () => Promise.resolve(),
    persistBatch: async rows => {
      const result = await harness.command('db_save_messages', { rows });
      if (!result.ok) throw new Error(result.error);
    },
  });
  failed.enqueueBatch([row(2)]);
  await failed.flush();
  assert.equal(failed.metrics.retries, 3);
  assert.equal(failed.metrics.droppedRows, 1);
  assert.equal(failed.metrics.queueSize, 0);
  assert.equal((await harness.command('db_count')).count, 1);
  assert.throws(() => assertLoadPersistenceHealthy(failed), /persistence failed/u);
  assert.equal((await harness.command('db_close')).ok, true);
});

test('mid-run abort cleans runtime, broker, database, persistence, child, and temp state', {
  timeout: 120_000,
}, async () => {
  const plan = parseLoadArgs([
    '--total-messages=200', '--payload-bytes=256', '--publish-concurrency=4',
    '--publish-rate-per-second=2000', '--timeout-ms=90000',
  ], {}).plan;
  for (const runtime of ['electron', 'tauri']) {
    const controller = new AbortController();
    let cleanup;
    const started = performance.now();
    await assert.rejects(runRuntimeLoad({
      runtime,
      plan,
      signal: controller.signal,
      progress(_runtime, published) {
        if (published >= 20) controller.abort(new Error(`${runtime} injected abort`));
      },
      onCleanup(value) { cleanup = value; },
    }), /injected abort/u);
    assert.ok(performance.now() - started < 30_000);
    assert.deepEqual(cleanup, {
      brokerClosed: true,
      runtimeClosed: true,
      openSockets: 0,
      trackedConnections: 0,
      pendingOperations: 0,
      pendingWaiters: 0,
      persistenceQueue: 0,
      childExited: runtime === 'tauri' ? true : null,
      databaseClosed: true,
      tempRemoved: true,
    });
  }
});

test('unexpected Tauri child exit has no unhandled rejection, cleans all state, and permits a fresh load', {
  timeout: 120_000,
}, async () => {
  const plan = parseLoadArgs([
    '--total-messages=40', '--payload-bytes=256', '--publish-concurrency=4',
    '--publish-rate-per-second=2000', '--timeout-ms=90000',
  ], {}).plan;
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  let cleanup;
  let temporary;
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(runRuntimeLoad({
      runtime: 'tauri',
      plan,
      signal: new AbortController().signal,
      async onReady(context) {
        temporary = context.temporary;
        await context.harness.terminate(new Error('injected forced child exit'));
      },
      onCleanup(value) { cleanup = value; },
    }), /injected forced child exit|exited|closed/iu);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(cleanup.runtimeClosed, true);
  assert.equal(cleanup.pendingOperations, 0);
  assert.equal(cleanup.pendingWaiters, 0);
  assert.equal(cleanup.childExited, true);
  assert.equal(cleanup.databaseClosed, true);
  assert.equal(cleanup.tempRemoved, true);
  await assert.rejects(access(temporary), { code: 'ENOENT' });
  const fresh = await runLoadGate(plan);
  assert.deepEqual(fresh.runtimes.map(metrics => metrics.received), [40, 40]);
});

test('small production harness load is exact and leaves every cleanup field drained', {
  timeout: 120_000,
}, async () => {
  const plan = parseLoadArgs([
    '--total-messages=40',
    '--payload-bytes=256',
    '--publish-concurrency=4',
    '--publish-rate-per-second=2000',
    '--timeout-ms=90000',
  ], {}).plan;
  const report = await runLoadGate(plan);

  assert.deepEqual(report.runtimes.map(({ runtime }) => runtime), ['electron', 'tauri']);
  for (const metrics of report.runtimes) {
    assert.equal(metrics.received, 40);
    assert.equal(metrics.unique, 40);
    assert.equal(metrics.databaseRows, 40);
    assert.equal(metrics.queueAfter, 0);
    assert.equal(metrics.droppedRows, 0);
    assert.equal(metrics.retries, 0);
    assert.equal(metrics.rssScope, 'total-harness-runtime');
    assert.ok(metrics.nativeMaxBatch <= 200);
    assert.ok(metrics.peakQueue <= 2_000);
    assert.deepEqual(metrics.cleanup, {
      brokerClosed: true,
      runtimeClosed: true,
      openSockets: 0,
      trackedConnections: 0,
      pendingOperations: 0,
      pendingWaiters: 0,
      persistenceQueue: 0,
      childExited: metrics.runtime === 'tauri' ? true : null,
      databaseClosed: true,
      tempRemoved: true,
    });
  }
});
