import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import mqtt from 'mqtt';

import { createBatchedPersistence } from '../../packages/workbench/src/workspace/batchedPersistence.js';
import { appendRealtimeItemsByConnection } from '../../packages/workbench/src/workspace/realtimeItems.js';
import { createElectronHarness } from './electronHarness.mjs';
import {
  DEFAULT_LOAD_PLAN,
  formatLoadHelp,
  parseLoadArgs,
  validateLoadPlan,
} from './loadPlan.mjs';
import { startLocalBroker } from './localBroker.mjs';
import { createTauriHarness } from './tauriHarness.mjs';

const require = createRequire(import.meta.url);
const { createDatabase } = require('../../apps/electron/electron/database.cjs');
const execFileAsync = promisify(execFile);
const VERIFICATION_PATH = fileURLToPath(new URL('../../docs/verification/mqtt-load-test.md', import.meta.url));
const HASHED_SOURCES = Object.freeze([
  'tooling/mqtt-load-test/loadPlan.mjs',
  'tooling/mqtt-load-test/loadRunner.mjs',
  'tooling/mqtt-load-test/electronHarness.mjs',
  'tooling/mqtt-load-test/tauriHarness.mjs',
  'apps/tauri/src-tauri/src/bin/mqtt_contract_harness.rs',
  'packages/workbench/src/workspace/batchedPersistence.js',
  'packages/workbench/src/workspace/realtimeItems.js',
  'apps/electron/electron/main.cjs',
  'apps/electron/electron/database.cjs',
  'apps/tauri/src-tauri/src/mqtt.rs',
  'apps/tauri/src-tauri/src/database.rs',
  'packages/mqtt-contract/src/index.js',
  'package-lock.json',
  'apps/tauri/src-tauri/Cargo.lock',
]);

function parseLoadPayload(payload) {
  const bytes = Buffer.from(payload);
  const newline = bytes.indexOf(0x0a);
  if (newline < 1) throw new Error('load payload is missing metadata terminator');
  let metadata;
  try {
    metadata = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
  } catch (error) {
    throw new Error(`load payload metadata is invalid: ${error.message}`, { cause: error });
  }
  return metadata;
}

export function makeLoadPayload({ payloadBytes, runtime, runId, connection, topic, sequence }) {
  const id = `${runtime}/${runId}/c${connection}/t${topic}/s${sequence}`;
  const metadata = Buffer.from(`${JSON.stringify({
    id,
    runtime,
    runId,
    connection,
    topic,
    sequence,
  })}\n`, 'ascii');
  if (!Number.isInteger(payloadBytes) || metadata.length > payloadBytes) {
    throw new RangeError(`payloadBytes ${payloadBytes} cannot contain load metadata`);
  }
  const payload = Buffer.alloc(payloadBytes, 0x20);
  metadata.copy(payload);
  return payload;
}

export function createMessageLedger({ plan, runtime, runId }) {
  const identifiers = new Set();
  const nextSequence = new Map();
  let realtimeItems = [];
  let received = 0;

  return Object.freeze({
    recordBatch(events) {
      const realtimeBatch = [];
      for (const event of events) {
        const payload = Buffer.from(event.payload);
        assert.equal(payload.byteLength, plan.payloadBytes, 'load payload byte length differs from plan');
        assert.equal(event.byteLength, plan.payloadBytes, 'native byte length differs from plan');
        const metadata = parseLoadPayload(payload);
        assert.equal(metadata.runtime, runtime, 'load payload runtime differs from active runtime');
        assert.equal(metadata.runId, runId, 'load payload runId differs from active run');
        assert.ok(Number.isInteger(metadata.connection) && metadata.connection >= 0
          && metadata.connection < plan.connections, 'load payload connection is out of range');
        assert.ok(Number.isInteger(metadata.topic) && metadata.topic >= 0
          && metadata.topic < plan.topicsPerConnection, 'load payload topic is out of range');
        assert.equal(event.connId, `load-${runId}-c${metadata.connection}`);
        assert.equal(event.topic, `load/${runId}/c${metadata.connection}/t${metadata.topic}`);
        assert.equal(event.qos, 1, 'load message must use QoS 1');
        assert.equal(event.retained, false, 'load message must use retained false');
        if (identifiers.has(metadata.id)) throw new Error(`duplicate load message: ${metadata.id}`);
        const expectedId = `${runtime}/${runId}/c${metadata.connection}/t${metadata.topic}/s${metadata.sequence}`;
        assert.equal(metadata.id, expectedId, 'load payload identity is inconsistent');
        const stream = `${metadata.connection}/${metadata.topic}`;
        const expectedSequence = nextSequence.get(stream) || 0;
        if (metadata.sequence !== expectedSequence) {
          throw new Error(`out-of-order load message for ${stream}: expected ${expectedSequence}, got ${metadata.sequence}`);
        }
        identifiers.add(metadata.id);
        nextSequence.set(stream, expectedSequence + 1);
        received += 1;
        realtimeBatch.push({ ...metadata, connId: event.connId });
      }
      realtimeItems = appendRealtimeItemsByConnection(
        realtimeItems,
        realtimeBatch,
        plan.realtimeMaxPerConnection,
      );
      return realtimeBatch;
    },
    finalize() {
      if (received !== plan.totalMessages) {
        throw new Error(`missing load messages: expected ${plan.totalMessages}, received ${received}`);
      }
      const perStream = plan.totalMessages / (plan.connections * plan.topicsPerConnection);
      for (let connection = 0; connection < plan.connections; connection += 1) {
        for (let topic = 0; topic < plan.topicsPerConnection; topic += 1) {
          const actual = nextSequence.get(`${connection}/${topic}`) || 0;
          if (actual !== perStream) {
            throw new Error(`missing load messages for ${connection}/${topic}: expected ${perStream}, received ${actual}`);
          }
        }
        const expectedRealtime = [];
        for (let sequence = 0; sequence < perStream; sequence += 1) {
          for (let topic = 0; topic < plan.topicsPerConnection; topic += 1) {
            expectedRealtime.push(`${runtime}/${runId}/c${connection}/t${topic}/s${sequence}`);
          }
        }
        const retained = realtimeItems.filter(
          message => message.connId === `load-${runId}-c${connection}`,
        );
        assert.deepEqual(
          retained.map(message => message.id),
          expectedRealtime.slice(-plan.realtimeMaxPerConnection),
          `realtime ring for connection ${connection} does not retain the deterministic tail`,
        );
      }
      const realtimeByConnection = new Map();
      for (let connection = 0; connection < plan.connections; connection += 1) {
        realtimeByConnection.set(
          connection,
          realtimeItems.filter(message => message.connection === connection),
        );
      }
      return Object.freeze({ received, unique: identifiers.size, realtimeByConnection });
    },
    get received() { return received; },
  });
}

export function createLoadPersistence({ plan, persistBatch, retryDelay, schedule, clear }) {
  let peakQueue = 0;
  let retries = 0;
  let maxBatch = 0;
  let droppedRows = 0;
  const failures = [];
  const dropReasons = [];
  const seenBatches = new WeakSet();
  const batcher = createBatchedPersistence({
    flushMs: 0,
    maxBatchSize: plan.persistenceBatch,
    maxQueueSize: plan.queueMax,
    maxRetries: plan.retryCount,
    retryDelay,
    schedule,
    clear,
    warn: () => {},
    async persistBatch(rows) {
      if (seenBatches.has(rows)) retries += 1;
      else seenBatches.add(rows);
      maxBatch = Math.max(maxBatch, rows.length);
      await persistBatch(rows);
    },
    onError(error, rows) {
      failures.push({ error, rows: rows.length });
    },
    onDrop(rows, metadata) {
      droppedRows += rows.length;
      dropReasons.push(metadata.reason);
    },
  });
  const metrics = Object.freeze({
    get peakQueue() { return peakQueue; },
    get retries() { return retries; },
    get droppedRows() { return droppedRows; },
    get queueSize() { return batcher.size(); },
    get maxBatch() { return maxBatch; },
    get failures() { return failures.length; },
    get dropReasons() { return [...dropReasons]; },
  });
  return Object.freeze({
    enqueueBatch(rows) {
      if (!Array.isArray(rows)) throw new TypeError('persistence rows must be an array');
      for (const row of rows) {
        peakQueue = Math.max(peakQueue, batcher.size() + 1);
        batcher.enqueue(row);
      }
    },
    flush: () => batcher.flush(),
    metrics,
  });
}

export function assertLoadPersistenceHealthy(persistence) {
  if (persistence.metrics.failures > 0 || persistence.metrics.droppedRows > 0) {
    throw new Error(
      `load persistence failed: ${persistence.metrics.failures} errors, `
      + `${persistence.metrics.droppedRows} dropped rows (${persistence.metrics.dropReasons.join(', ')})`,
    );
  }
  assert.equal(persistence.metrics.queueSize, 0, 'load persistence queue did not drain');
}

export async function runWithCleanup({ signal, resources, operation }) {
  let operationError = null;
  let result;
  try {
    if (signal?.aborted) throw signal.reason;
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = [];
  for (const resource of [...resources].reverse()) {
    try { await resource.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'load cleanup failed');
  return result;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function abortPromise(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

function delay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    function finish() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function connectPublisher(broker, runtime, runId, signal) {
  const client = mqtt.connect(`mqtt://${broker.host}:${broker.port}`, {
    clientId: `load-publisher-${runtime}-${runId}`,
    username: broker.username,
    password: broker.password,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 8_000,
  });
  const ready = new Promise((resolve, reject) => {
    const cleanup = () => {
      client.removeListener('connect', connected);
      client.removeListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const connected = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error); };
    const aborted = () => { cleanup(); reject(signal.reason); };
    client.once('connect', connected);
    client.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
  });
  client.on('error', () => {});
  return { client, ready };
}

function publish(client, topic, payload, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    client.publish(topic, payload, { qos: 1, retain: false }, error => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    });
  });
}

function closePublisher(client) {
  if (!client) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { client.end(true); } catch { /* Continue cleanup. */ }
      finish();
    }, 3_000);
    try { client.end(false, finish); } catch { finish(); }
  });
}

async function publishPlan({ client, plan, runtime, runId, signal, onProgress }) {
  const perStream = plan.totalMessages / (plan.connections * plan.topicsPerConnection);
  const started = performance.now();
  let published = 0;
  let pending = [];
  const flush = async () => {
    await Promise.all(pending);
    pending = [];
    const targetElapsed = (published / plan.publishRatePerSecond) * 1_000;
    await delay(targetElapsed - (performance.now() - started), signal);
    onProgress?.(published);
  };
  for (let sequence = 0; sequence < perStream; sequence += 1) {
    for (let connection = 0; connection < plan.connections; connection += 1) {
      for (let topic = 0; topic < plan.topicsPerConnection; topic += 1) {
        const payload = makeLoadPayload({
          payloadBytes: plan.payloadBytes,
          runtime,
          runId,
          connection,
          topic,
          sequence,
        });
        pending.push(publish(
          client,
          `load/${runId}/c${connection}/t${topic}`,
          payload,
          signal,
        ));
        published += 1;
        if (pending.length === plan.publishConcurrency) await flush();
      }
    }
  }
  if (pending.length > 0) await flush();
}

export function parsePsRss(output) {
  const kibibytes = Number(String(output).trim());
  return Number.isFinite(kibibytes) && kibibytes > 0 ? kibibytes * 1_024 : null;
}

export function parseWindowsWorkingSet(output) {
  const bytes = Number(String(output).trim());
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function assertRssPlatform(platformName) {
  if (!['darwin', 'linux', 'win32'].includes(platformName)) {
    throw new Error(`unsupported RSS platform: ${platformName}`);
  }
}

export async function sampleChildRss(pid, {
  platformName = process.platform,
  execFileImpl = execFileAsync,
} = {}) {
  assertRssPlatform(platformName);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`RSS child pid is invalid: ${pid}`);
  if (platformName === 'darwin' || platformName === 'linux') {
    const { stdout } = await execFileImpl(
      'ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2_000 },
    );
    return measuredRss(parsePsRss(stdout), `${platformName} child RSS`);
  }
  const { stdout } = await execFileImpl('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
  ], { timeout: 2_000 });
  return measuredRss(parseWindowsWorkingSet(stdout), 'Windows child RSS');
}

export async function sampleRss(runtime, harness, {
  platformName = process.platform,
  memoryUsage = process.memoryUsage,
  childSampler = sampleChildRss,
} = {}) {
  assertRssPlatform(platformName);
  const runnerRss = measuredRss(memoryUsage().rss, 'Node runner RSS');
  if (runtime === 'electron') return runnerRss;
  if (!harness || harness.isClosed || harness.childExited) {
    if (harness?.terminalError) throw harness.terminalError;
    throw new Error('Tauri RSS requires a live Rust child process');
  }
  const childRss = await childSampler(harness.processId, { platformName });
  return measuredRss(runnerRss + childRss, 'total Tauri harness RSS');
}

function measuredRss(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be finite measured bytes`);
  }
  return value;
}

function assertMetrics(plan, metrics) {
  assert.equal(metrics.received, plan.totalMessages);
  assert.equal(metrics.unique, plan.totalMessages);
  assert.equal(metrics.databaseRows, plan.totalMessages);
  assert.ok(metrics.nativeMaxBatch <= plan.nativeEventBatch);
  assert.ok(metrics.persistenceMaxBatch <= plan.persistenceBatch);
  assert.ok(metrics.peakQueue <= plan.queueMax);
  assert.equal(metrics.queueAfter, 0);
  assert.equal(metrics.droppedRows, 0);
  assert.equal(metrics.retries, 0);
  assert.equal(metrics.rssScope, 'total-harness-runtime');
  for (const value of [metrics.rssBefore, metrics.rssPeak, metrics.rssAfter]) {
    assert.ok(Number.isFinite(value) && value > 0, 'RSS metrics must be finite measured bytes');
  }
  assert.ok(metrics.rssPeak - metrics.rssBefore < plan.rssGrowthLimitBytes);
  const cleanupKeys = [
    'brokerClosed', 'runtimeClosed', 'openSockets', 'trackedConnections',
    'pendingOperations', 'pendingWaiters', 'persistenceQueue', 'childExited',
    'databaseClosed', 'tempRemoved',
  ];
  assert.deepEqual(Object.keys(metrics.cleanup), cleanupKeys);
  assert.equal(metrics.cleanup.brokerClosed, true);
  assert.equal(metrics.cleanup.runtimeClosed, true);
  assert.equal(metrics.cleanup.openSockets, 0);
  assert.equal(metrics.cleanup.trackedConnections, 0);
  assert.equal(metrics.cleanup.pendingOperations, 0);
  assert.equal(metrics.cleanup.pendingWaiters, 0);
  assert.equal(metrics.cleanup.persistenceQueue, 0);
  assert.equal(metrics.cleanup.childExited, metrics.runtime === 'tauri' ? true : null);
  assert.equal(metrics.cleanup.databaseClosed, true);
  assert.equal(metrics.cleanup.tempRemoved, true);
}

export async function runRuntimeLoad({
  runtime,
  plan,
  signal,
  progress,
  rssSampler = sampleRss,
  rssSampleIntervalMs = 50,
  onReady = () => {},
  onCleanup = () => {},
}) {
  validateLoadPlan(plan);
  const runId = randomUUID();
  const temporary = await mkdtemp(join(tmpdir(), `ineed-mqtt-load-${runtime}-`));
  const databasePath = join(temporary, `${runtime}.db`);
  const connectionIds = Array.from(
    { length: plan.connections },
    (_, connection) => `load-${runId}-c${connection}`,
  );
  let broker = null;
  const ledger = createMessageLedger({ plan, runtime, runId });
  const completed = deferred();
  void completed.promise.catch(() => {});
  let callbackFailure = null;
  let nativeMaxBatch = 0;
  let database = null;
  let persistence = null;
  let harness = null;
  let publisher = null;
  let rssBefore;
  let rssPeak;
  let rssAfter;
  let sampler = null;
  let samplerChain = Promise.resolve();
  let samplerFailure = null;
  let metrics = null;
  let operationError = null;
  let databaseClosed = false;
  const cleanupErrors = [];
  const persistenceRows = messages => messages.map(message => ({
    connection_id: message.connId,
    topic: message.topic,
    payload: Buffer.from(message.payload).toString('utf8'),
    direction: 'in',
    qos: message.qos,
    retained: message.retained ? 1 : 0,
    format: 'text',
  }));
  const handleBatch = messages => {
    try {
      nativeMaxBatch = Math.max(nativeMaxBatch, messages.length);
      if (messages.length > plan.nativeEventBatch) {
        throw new Error(`native MQTT batch ${messages.length} exceeds ${plan.nativeEventBatch}`);
      }
      persistence.enqueueBatch(persistenceRows(messages));
      ledger.recordBatch(messages);
      if (ledger.received === plan.totalMessages) completed.resolve();
    } catch (error) {
      callbackFailure = error;
      completed.reject(error);
      throw error;
    }
  };
  const queueRssSample = () => {
    samplerChain = samplerChain.then(async () => {
      if (samplerFailure) return;
      try {
        const value = measuredRss(
          await rssSampler(runtime, harness),
          'periodic RSS sample',
        );
        rssPeak = Math.max(rssPeak, value);
      } catch (error) {
        samplerFailure = error;
      }
    });
  };
  const stopRssSampler = async () => {
    if (sampler) {
      clearInterval(sampler);
      sampler = null;
    }
    await samplerChain;
    if (samplerFailure) throw samplerFailure;
  };

  try {
    broker = await startLocalBroker();
    if (runtime === 'electron') {
      database = createDatabase(databasePath);
      for (const id of connectionIds) {
        database.saveConnection({ id, name: id, host: broker.host, port: broker.port });
      }
      harness = createElectronHarness({ onMessageBatch: handleBatch });
    } else {
      harness = await createTauriHarness({ onMessageBatch: handleBatch });
      const initialized = await harness.command('db_init', { databasePath, connectionIds });
      assert.equal(initialized.ok, true, initialized.error);
    }
    persistence = createLoadPersistence({
      plan,
      retryDelay: () => Promise.resolve(),
      persistBatch: runtime === 'electron'
        ? rows => database.saveMessages(rows)
        : async rows => {
          const result = await harness.command('db_save_messages', { rows });
          if (!result.ok) throw new Error(result.error);
        },
    });
    await onReady({ harness, broker, temporary, databasePath, persistence });
    rssBefore = measuredRss(await rssSampler(runtime, harness), 'RSS baseline');
    rssPeak = rssBefore;
    sampler = setInterval(queueRssSample, rssSampleIntervalMs);
    sampler.unref?.();

    for (let connection = 0; connection < plan.connections; connection += 1) {
      const connId = connectionIds[connection];
      const result = await harness.command('connect', {
        id: connId,
        host: broker.host,
        port: broker.port,
        protocol: 'mqtt',
        clientId: `${runtime}-${runId}-c${connection}`,
        username: broker.username,
        password: broker.password,
        cleanSession: true,
        autoReconnect: false,
      }, { signal });
      assert.equal(result.ok, true, result.error);
      const subscribed = await harness.command(
        'subscribe', connId, `load/${runId}/c${connection}/#`, 1, { signal },
      );
      assert.equal(subscribed.ok, true, subscribed.error);
    }
    const publisherConnection = connectPublisher(broker, runtime, runId, signal);
    publisher = publisherConnection.client;
    await publisherConnection.ready;
    await publishPlan({
      client: publisher,
      plan,
      runtime,
      runId,
      signal,
      onProgress: published => progress?.(runtime, published),
    });
    await Promise.race([completed.promise, abortPromise(signal)]);
    if (callbackFailure) throw callbackFailure;
    const ledgerMetrics = ledger.finalize();
    await persistence.flush();
    assertLoadPersistenceHealthy(persistence);
    let databaseRows;
    let databaseBytes;
    if (runtime === 'electron') {
      const storage = database.getStorageStats();
      databaseRows = storage.messageCount;
      databaseBytes = storage.totalBytes;
    } else {
      const stats = await harness.command('db_count', {}, { signal });
      assert.equal(stats.ok, true, stats.error);
      databaseRows = stats.count;
      databaseBytes = stats.databaseBytes;
    }
    for (const connectionId of connectionIds) {
      const disconnected = await harness.command('disconnect', connectionId, { signal });
      assert.equal(disconnected.ok, true, disconnected.error);
    }
    await closePublisher(publisher);
    publisher = null;
    await stopRssSampler();
    rssAfter = measuredRss(await rssSampler(runtime, harness), 'final RSS sample');
    rssPeak = Math.max(rssPeak, rssAfter);
    metrics = {
      runtime,
      runId,
      durationMs: 0,
      throughputPerSecond: 0,
      received: ledgerMetrics.received,
      unique: ledgerMetrics.unique,
      databaseRows,
      databaseBytes,
      nativeMaxBatch,
      persistenceMaxBatch: persistence.metrics.maxBatch,
      peakQueue: persistence.metrics.peakQueue,
      queueAfter: persistence.metrics.queueSize,
      droppedRows: persistence.metrics.droppedRows,
      retries: persistence.metrics.retries,
      rssBefore,
      rssPeak,
      rssAfter,
      rssScope: 'total-harness-runtime',
      cleanup: null,
    };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await stopRssSampler();
    } catch (error) {
      if (!operationError) operationError = error;
      else if (operationError !== error) cleanupErrors.push(error);
    }
    try { await closePublisher(publisher); } catch (error) { cleanupErrors.push(error); }
    if (harness && !harness.isClosed) {
      for (const connectionId of connectionIds) {
        try { await harness.command('disconnect', connectionId); } catch { /* close() is the fallback. */ }
      }
    }
    if (persistence) {
      try { await persistence.flush(); } catch (error) { cleanupErrors.push(error); }
    }
    if (runtime === 'tauri' && harness && !harness.isClosed) {
      try {
        const result = await harness.command('db_close');
        if (result.ok) databaseClosed = true;
        else cleanupErrors.push(new Error(result.error));
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (database) {
      try {
        database.closeDatabase();
        databaseClosed = true;
      } catch (error) { cleanupErrors.push(error); }
    }
    if (harness) {
      try { await harness.close(); } catch (error) { cleanupErrors.push(error); }
    }
    const runtimeDiagnostics = harness?.diagnostics || {};
    if (runtime === 'tauri' && harness?.childExited) databaseClosed = true;
    if (broker) {
      try { await broker.close(); } catch (error) { cleanupErrors.push(error); }
    }
    try { await rm(temporary, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    let tempRemoved = false;
    try { await access(temporary); } catch (error) { tempRemoved = error.code === 'ENOENT'; }
    const cleanup = {
      brokerClosed: broker?.isClosed === true,
      runtimeClosed: harness?.isClosed === true,
      openSockets: broker?.openSocketCount ?? -1,
      trackedConnections: harness?.connectionCount ?? -1,
      pendingOperations: runtimeDiagnostics.pendingOperations
        ?? runtimeDiagnostics.pendingRequests
        ?? -1,
      pendingWaiters: runtimeDiagnostics.pendingWaiters ?? -1,
      persistenceQueue: persistence?.metrics.queueSize ?? -1,
      childExited: runtime === 'tauri' ? harness?.childExited === true : null,
      databaseClosed,
      tempRemoved,
    };
    if (metrics) metrics.cleanup = cleanup;
    try { onCleanup(cleanup); } catch (error) { cleanupErrors.push(error); }
  }
  if (operationError) {
    if (cleanupErrors.length > 0) operationError.cleanupErrors = cleanupErrors;
    throw operationError;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `${runtime} load cleanup failed`);
  return metrics;
}

async function commandVersion(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5_000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

async function gitStatusPorcelain() {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { timeout: 5_000 });
  return stdout;
}

export async function assertRecordProvenance({
  statusPorcelain = gitStatusPorcelain,
  commit = () => commandVersion('git', ['rev-parse', 'HEAD']),
} = {}) {
  const status = await statusPorcelain();
  if (status.trim() !== '') {
    throw new Error('load --record requires a clean git worktree');
  }
  const implementationCommit = await commit();
  if (!implementationCommit) throw new Error('load --record could not resolve implementation commit');
  return Object.freeze({ dirty: false, implementationCommit });
}

export async function runLoadGate(plan = DEFAULT_LOAD_PLAN, {
  progress,
  runtimeRunner = runRuntimeLoad,
  provenance,
} = {}) {
  validateLoadPlan(plan);
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`MQTT load gate exceeded ${plan.timeoutMs}ms`));
  }, plan.timeoutMs);
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const runtimes = [];
    for (const runtime of ['electron', 'tauri']) {
      const runtimeStarted = performance.now();
      const metrics = await runtimeRunner({ runtime, plan, signal: controller.signal, progress });
      metrics.durationMs = performance.now() - runtimeStarted;
      metrics.throughputPerSecond = plan.totalMessages / (metrics.durationMs / 1_000);
      assertMetrics(plan, metrics);
      runtimes.push(Object.freeze(metrics));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'load gate observed an unhandled rejection');
    const resolvedProvenance = provenance || Object.freeze({
      dirty: (await gitStatusPorcelain()).trim() !== '',
      implementationCommit: await commandVersion('git', ['rev-parse', 'HEAD']),
    });
    const environment = Object.freeze({
      node: process.version,
      npm: await commandVersion('npm', ['--version']),
      rust: await commandVersion('rustc', ['--version']),
      cargo: await commandVersion('cargo', ['--version']),
      os: `${platform()} ${release()}`,
      arch: arch(),
      dirty: resolvedProvenance.dirty,
      implementationCommit: resolvedProvenance.implementationCommit,
    });
    const sourceSha256 = Object.freeze(Object.fromEntries(await Promise.all(
      HASHED_SOURCES.map(async relativePath => [
        relativePath,
        createHash('sha256').update(await readFile(new URL(`../../${relativePath}`, import.meta.url))).digest('hex'),
      ]),
    )));
    return Object.freeze({
      plan,
      planSha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
      sourceSha256,
      durationMs: performance.now() - started,
      environment,
      runtimes: Object.freeze(runtimes),
    });
  } finally {
    clearTimeout(timer);
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

function bytes(value) {
  return value === null ? 'unavailable' : `${(value / (1_024 * 1_024)).toFixed(2)} MiB`;
}

export function formatVerificationReport(report) {
  const lines = [
    '# MQTT Load Verification',
    '',
    `Fresh run: ${new Date().toISOString()}`,
    '',
    `Plan SHA-256: \`${report.planSha256}\``,
    '',
    `Plan: \`${JSON.stringify(report.plan)}\``,
    '',
    'Source SHA-256:',
    '',
    ...Object.entries(report.sourceSha256).map(([path, hash]) => `- \`${path}\`: \`${hash}\``),
    '',
    `Environment: Node ${report.environment.node}; npm ${report.environment.npm}; ${report.environment.rust}; ${report.environment.cargo}; ${report.environment.os}; ${report.environment.arch}; dirty=${report.environment.dirty}; implementation commit \`${report.environment.implementationCommit}\`.`,
    '',
    'RSS scope: `total-harness-runtime`. Electron measures the Node runner containing broker, publisher, shared queue/realtime state, database, and coordinator. Tauri measures that same Node runner plus the live Rust child process. Every baseline, periodic, and final sample is required; an unavailable or invalid sample fails the gate.',
    '',
    'Windows coverage: PowerShell RSS command construction/parsing and process-tree termination are unit-tested. Native Windows integration evidence requires a Windows run.',
    '',
    '| Runtime | Messages | Duration | Throughput | Native max | Persist max | Peak queue | Retries | Dropped | Total RSS before / peak / after | DB bytes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const metrics of report.runtimes) {
    lines.push(`| ${metrics.runtime} | ${metrics.received} | ${metrics.durationMs.toFixed(0)} ms | ${metrics.throughputPerSecond.toFixed(1)} msg/s | ${metrics.nativeMaxBatch} | ${metrics.persistenceMaxBatch} | ${metrics.peakQueue} | ${metrics.retries} | ${metrics.droppedRows} | ${bytes(metrics.rssBefore)} / ${bytes(metrics.rssPeak)} / ${bytes(metrics.rssAfter)} | ${metrics.databaseBytes} |`);
  }
  lines.push('', `Overall duration: ${report.durationMs.toFixed(0)} ms.`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const parsed = parseLoadArgs(process.argv.slice(2), process.env);
  if (parsed.help) {
    process.stdout.write(formatLoadHelp());
    return;
  }
  const provenance = parsed.record ? await assertRecordProvenance() : undefined;
  const lastProgress = new Map();
  const report = await runLoadGate(parsed.plan, {
    provenance,
    progress(runtime, published) {
      const previous = lastProgress.get(runtime) || 0;
      if (published !== parsed.plan.totalMessages && published - previous < 2_000) return;
      lastProgress.set(runtime, published);
      process.stdout.write(`${runtime}: published ${published}/${parsed.plan.totalMessages}\n`);
    },
  });
  const markdown = formatVerificationReport(report);
  process.stdout.write(markdown);
  if (parsed.record) await writeFile(VERIFICATION_PATH, markdown, 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
