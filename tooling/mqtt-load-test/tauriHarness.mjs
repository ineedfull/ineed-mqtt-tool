import { execFile, spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeMqttStatus } from '@ineed-mqtt-tool/mqtt-contract';

const MAX_OUTPUT_LINE_BYTES = 12 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export function resolveCargoManifest(
  moduleUrl = import.meta.url,
  { windows = process.platform === 'win32' } = {},
) {
  const path = windows ? win32 : posix;
  const modulePath = fileURLToPath(moduleUrl, { windows });
  return path.resolve(path.dirname(modulePath), '../../apps/tauri/src-tauri/Cargo.toml');
}

const MANIFEST = resolveCargoManifest();

export function createBoundedTextCollector(maxBytes, label) {
  let chunks = [];
  let bytes = 0;
  let failure = null;
  return Object.freeze({
    push(chunk) {
      if (failure) throw failure;
      const input = Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const accepted = input.subarray(0, remaining);
        chunks.push(accepted);
        bytes += accepted.length;
      }
      if (input.length > remaining) {
        failure = new Error(`${label} exceeds ${maxBytes} bytes`);
        throw failure;
      }
    },
    get text() { return Buffer.concat(chunks, bytes).toString('utf8'); },
    get error() { return failure; },
    clear() { chunks = []; bytes = 0; },
  });
}

export function createNdjsonParser({ maxLineBytes = MAX_OUTPUT_LINE_BYTES, onValue }) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = Buffer.alloc(0);
  let failure = null;
  const fail = error => {
    if (!failure) failure = error;
    throw failure;
  };
  const append = part => {
    if (buffered.length + part.length > maxLineBytes) {
      fail(new Error(`stdout line exceeds ${maxLineBytes} bytes`));
    }
    if (part.length > 0) buffered = Buffer.concat([buffered, part], buffered.length + part.length);
  };
  return Object.freeze({
    push(chunk) {
      if (failure) throw failure;
      const input = Buffer.from(chunk);
      let offset = 0;
      while (offset < input.length) {
        const newline = input.indexOf(0x0a, offset);
        if (newline === -1) {
          append(input.subarray(offset));
          return;
        }
        append(input.subarray(offset, newline));
        const line = buffered.length > 0 && buffered.at(-1) === 0x0d
          ? buffered.subarray(0, -1)
          : buffered;
        buffered = Buffer.alloc(0);
        if (line.length > 0) {
          let value;
          try {
            value = JSON.parse(decoder.decode(line));
          } catch (error) {
            const reason = error instanceof TypeError ? `invalid UTF-8: ${error.message}` : error.message;
            fail(new Error(`invalid Rust MQTT NDJSON: ${reason}`));
          }
          onValue(value);
        }
        offset = newline + 1;
      }
    },
    end() {
      if (buffered.length > 0) fail(new Error('Rust MQTT stdout ended with an incomplete NDJSON line'));
    },
    get bufferedBytes() { return buffered.length; },
    get error() { return failure; },
  });
}

export function createChildOutputGuard({
  maxStdoutLineBytes = MAX_OUTPUT_LINE_BYTES,
  maxStderrBytes = MAX_STDERR_BYTES,
  onValue,
  terminate,
}) {
  const stderr = createBoundedTextCollector(maxStderrBytes, 'stderr');
  let failure = null;
  const fail = error => {
    if (failure) return;
    failure = error;
    terminate(error);
  };
  const parser = createNdjsonParser({ maxLineBytes: maxStdoutLineBytes, onValue });
  return Object.freeze({
    pushStdout(chunk) {
      if (failure) return;
      try { parser.push(chunk); } catch (error) { fail(error); }
    },
    endStdout() {
      if (failure) return;
      try { parser.end(); } catch (error) { fail(error); }
    },
    pushStderr(chunk) {
      if (failure) return;
      try { stderr.push(chunk); } catch (error) { fail(error); }
    },
    get stderrText() { return stderr.text; },
    get error() { return failure; },
    get bufferedStdoutBytes() { return parser.bufferedBytes; },
  });
}

function bounded(promise, label, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForClose(closed, timeoutMs) {
  let timer;
  return Promise.race([
    closed.then(() => true, () => false),
    new Promise(resolve => {
      // Keep the awaited deadline alive even after the child releases its last handle.
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function terminateProcessTree(child, closed, {
  platformName = process.platform,
  execFileImpl = execFile,
  killProcess = process.kill,
  closeTimeoutMs = TERMINATION_GRACE_MS,
} = {}) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) {
    if (await waitForClose(closed, closeTimeoutMs)) return;
    throw new Error(`Rust MQTT child did not close within ${closeTimeoutMs} ms`);
  }

  if (platformName === 'win32') {
    let taskkillError = null;
    await new Promise(resolve => {
      try {
        execFileImpl(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          { timeout: closeTimeoutMs, windowsHide: true },
          error => { taskkillError = error; resolve(); },
        );
      } catch (error) {
        taskkillError = error;
        resolve();
      }
    });
    if (taskkillError) {
      try { child.kill('SIGKILL'); } catch { /* The close gate below is authoritative. */ }
    }
    if (await waitForClose(closed, closeTimeoutMs)) return;
    try { child.kill('SIGKILL'); } catch { /* The hard close error remains primary. */ }
    if (await waitForClose(closed, closeTimeoutMs)) return;
    const detail = taskkillError ? `; taskkill failed: ${taskkillError.message}` : '';
    throw new Error(
      `Rust MQTT process tree did not close within ${closeTimeoutMs} ms${detail}`,
    );
  }

  if (platformName !== 'darwin' && platformName !== 'linux') {
    throw new Error(`unsupported process-tree termination platform: ${platformName}`);
  }
  try {
    killProcess(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      try { child.kill('SIGKILL'); } catch { /* The close gate below is authoritative. */ }
    }
  }
  if (await waitForClose(closed, closeTimeoutMs)) return;
  throw new Error(
    `Rust MQTT process group did not close within ${closeTimeoutMs} ms after SIGKILL`,
  );
}

function spawnCaptured(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = createBoundedTextCollector(32 * 1024 * 1024, `${command} stdout`);
    const stderr = createBoundedTextCollector(MAX_STDERR_BYTES, `${command} stderr`);
    let outputError = null;
    const capture = collector => chunk => {
      try { collector.push(chunk); } catch (error) {
        if (!outputError) outputError = error;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (outputError) reject(outputError);
      else if (code === 0) resolve({ stdout: stdout.text, stderr: stderr.text });
      else reject(new Error(`${command} exited ${code ?? signal}: ${stderr.text}`));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  });
}

export async function buildTauriHarness() {
  const result = await spawnCaptured('cargo', [
    'build', '--locked', '--manifest-path', MANIFEST,
    '--bin', 'mqtt_contract_harness', '--message-format=json-render-diagnostics',
  ], 120_000);
  let executable = null;
  for (const line of result.stdout.split('\n')) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.reason === 'compiler-artifact' && message.target?.name === 'mqtt_contract_harness') {
      executable = message.executable;
    }
  }
  if (!executable) throw new Error(`Cargo did not report mqtt_contract_harness executable: ${result.stderr}`);
  return executable;
}

function normalizeRustMessage(input) {
  const bytes = Uint8Array.from(Buffer.from(String(input.payloadHex), 'hex'));
  return {
    type: 'message',
    connId: String(input.connId),
    topic: String(input.topic),
    payload: bytes,
    payloadText: String(input.payload),
    payloadHex: Buffer.from(bytes).toString('hex'),
    byteLength: bytes.byteLength,
    qos: Number(input.qos),
    retained: Boolean(input.retained),
    timestamp: Date.parse(input.time),
  };
}

export async function createTauriHarness({ onMessageBatch = () => {} } = {}) {
  const executable = await buildTauriHarness();
  const child = spawn(executable, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const events = [];
  const eventWaiters = new Set();
  const results = new Map();
  const connections = new Set();
  let nextId = 1;
  let closed = false;
  let terminalError = null;
  let terminatedAfterRequestAbort = false;
  let childExited = false;
  let output;
  let terminationOutcome = null;

  const deliver = event => {
    events.push(event);
    for (const waiter of [...eventWaiters]) {
      if (!waiter.predicate(event)) continue;
      eventWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  };
  const handleMessage = (message) => {
    if (message.kind === 'result') {
      const pending = results.get(message.id);
      if (!pending) return;
      pending.resolve(message.value);
    } else if (message.kind === 'event' && message.channel === 'mqtt:messages') {
      const messages = message.payload.map(normalizeRustMessage);
      onMessageBatch(messages);
      for (const item of messages) deliver(item);
    } else if (message.kind === 'event' && message.channel === 'mqtt:status') {
      deliver({ type: 'status', ...normalizeMqttStatus(message.payload) });
    }
  };
  const rejectEventWaiters = (error) => {
    for (const waiter of [...eventWaiters]) {
      eventWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  const exitedOutcome = new Promise((resolve) => {
    child.once('error', (error) => {
      if (!terminalError) terminalError = error;
    });
    child.once('close', (code, signal) => {
      childExited = true;
      closed = true;
      connections.clear();
      const error = terminalError || (code === 0
        ? null
        : new Error(`Rust MQTT harness exited ${code ?? signal}: ${output?.stderrText || ''}`));
      for (const pending of [...results.values()]) pending.reject(error || new Error('Rust MQTT harness closed'));
      rejectEventWaiters(error || new Error('Rust MQTT harness closed'));
      resolve(Object.freeze({ error }));
    });
  });
  const terminateChild = (error) => {
    if (!terminalError) terminalError = error;
    if (!terminationOutcome) {
      terminationOutcome = terminateProcessTree(child, exitedOutcome)
        .then(() => Object.freeze({ error: null }), failure => Object.freeze({ error: failure }));
    }
    return terminationOutcome;
  };
  const terminateAfterRequestAbort = (error) => {
    if (terminatedAfterRequestAbort) return;
    terminatedAfterRequestAbort = true;
    closed = true;
    terminateChild(error instanceof Error ? error : new Error('Rust MQTT request aborted'));
    for (const pending of [...results.values()]) pending.reject(error);
    rejectEventWaiters(error);
  };
  output = createChildOutputGuard({ onValue: handleMessage, terminate: terminateChild });
  child.stdout.on('data', output.pushStdout);
  child.stdout.on('end', output.endStdout);
  child.stderr.on('data', output.pushStderr);

  function request(command, args, { timeoutMs = 8_000, signal } = {}) {
    if (terminatedAfterRequestAbort) {
      return Promise.reject(new Error('Rust MQTT harness terminated after request abort'));
    }
    if (closed) return Promise.reject(new Error('Rust MQTT harness is closed'));
    if (signal?.aborted) {
      terminateAfterRequestAbort(signal.reason);
      return Promise.reject(signal.reason);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const finish = (operation, value) => {
        const pending = results.get(id);
        if (!pending) return;
        results.delete(id);
        clearTimeout(pending.timer);
        signal?.removeEventListener('abort', abort);
        operation(value);
      };
      const abort = () => terminateAfterRequestAbort(signal.reason);
      const timer = setTimeout(() => {
        terminateAfterRequestAbort(new Error(`Rust MQTT ${command} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      results.set(id, {
        resolve: value => finish(resolve, value),
        reject: error => finish(reject, error),
        timer,
      });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, command, args })}\n`, (error) => {
        if (!error) return;
        finish(reject, error);
      });
    });
  }

  function waitFor(predicate, timeoutMs = 4_000, signal) {
    if (terminatedAfterRequestAbort) {
      return Promise.reject(new Error('Rust MQTT harness terminated after request abort'));
    }
    const existing = events.findLast(predicate);
    if (existing) return Promise.resolve(existing);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      const abort = () => {
        eventWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        reject(signal.reason);
      };
      waiter.timer = setTimeout(() => {
        eventWaiters.delete(waiter);
        signal?.removeEventListener('abort', abort);
        reject(new Error(`Rust MQTT event wait exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      waiter.resolve = value => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      eventWaiters.add(waiter);
    });
  }

  return Object.freeze({
    runtime: 'tauri',
    events,
    async command(name, ...args) {
      const options = args.at(-1)?.signal ? args.pop() : {};
      let payload;
      if (name === 'connect') payload = { conn: args[0] };
      else if (name === 'disconnect') payload = { connId: args[0] };
      else if (name === 'subscribe') payload = { connId: args[0], topic: args[1], qos: args[2] };
      else if (name === 'unsubscribe') payload = { connId: args[0], topic: args[1] };
      else if (name === 'publish') payload = { connId: args[0], topic: args[1], payload: args[2], qos: args[3], retain: args[4] };
      else if (name.startsWith('db_')) payload = args[0] || {};
      else payload = {};
      const result = await request(name, payload, options);
      if (name === 'connect' && result.ok) connections.add(args[0].id);
      if (name === 'disconnect' && result.ok) connections.delete(args[0]);
      return result;
    },
    waitMessage(predicate, timeoutMs, signal) {
      return waitFor(event => event.type === 'message' && predicate(event), timeoutMs, signal);
    },
    waitStatus(predicate, timeoutMs, signal) {
      return waitFor(event => event.type === 'status' && predicate(event), timeoutMs, signal);
    },
    async expectNoMessage(predicate, durationMs = 500, signal) {
      const start = events.length;
      await new Promise((resolve, reject) => {
        const finish = (operation, value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          operation(value);
        };
        const timer = setTimeout(() => finish(resolve), durationMs);
        const abort = () => {
          finish(reject, signal.reason);
        };
        signal?.addEventListener('abort', abort, { once: true });
      });
      if (events.slice(start).some(event => event.type === 'message' && predicate(event))) {
        throw new Error('unexpected MQTT message after unsubscribe');
      }
    },
    async terminate(error = new Error('Rust MQTT harness terminated')) {
      const outcome = await terminateChild(error);
      if (outcome.error) throw outcome.error;
    },
    async close() {
      if (terminatedAfterRequestAbort) {
        connections.clear();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        const termination = await terminationOutcome;
        if (termination.error) throw termination.error;
        await bounded(exitedOutcome, 'Rust MQTT aborted cleanup', 1_000);
        return;
      }
      if (closed && childExited) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        return;
      }
      try {
        await bounded((async () => {
          await Promise.allSettled([...connections].map(connId => (
            request('disconnect', { connId }, { timeoutMs: 2_500 })
          )));
          connections.clear();
          closed = true;
          child.stdin.end();
          const outcome = await exitedOutcome;
          if (outcome.error) throw outcome.error;
        })(), 'Rust MQTT harness cleanup', 6_000);
      } catch (error) {
        closed = true;
        const termination = await terminateChild(error);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (termination.error) {
          throw new AggregateError(
            [error, termination.error],
            'Rust MQTT forced cleanup failed',
            { cause: error },
          );
        }
        await bounded(exitedOutcome, 'Rust MQTT forced cleanup', 1_000);
        throw error;
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    },
    get diagnostics() {
      return {
        closed,
        pendingRequests: results.size,
        pendingWaiters: eventWaiters.size,
      };
    },
    get processId() { return child.pid; },
    get isClosed() { return closed; },
    get connectionCount() { return connections.size; },
    get childExited() { return childExited; },
    get terminalError() { return terminalError; },
  });
}
