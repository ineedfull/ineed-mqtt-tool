import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import test from 'node:test';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron');
const electronRoot = resolve(import.meta.dirname, '..');
const SMOKE_TIMEOUT_MS = 25_000;
const TERMINATION_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 1_048_576;

function delay(milliseconds) {
  return new Promise(resolvePromise => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
  });
}

function signalChild(child, signal, {
  killProcess = process.kill,
  platform = process.platform,
} = {}) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  try {
    if (platform === 'win32') child.kill(signal);
    else killProcess(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForClose(closed, timeoutMs) {
  let timer;
  return Promise.race([
    closed.then(() => true, () => false),
    new Promise(resolvePromise => {
      timer = setTimeout(() => resolvePromise(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function terminateWindowsProcessTree(child, closed, {
  closeTimeoutMs = TERMINATION_GRACE_MS,
  execFileImpl = execFile,
} = {}) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  let taskkillError = null;
  const killed = await new Promise(resolvePromise => {
    try {
      execFileImpl(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        { timeout: TERMINATION_GRACE_MS, windowsHide: true },
        error => {
          taskkillError = error;
          resolvePromise(error == null);
        },
      );
    } catch {
      resolvePromise(false);
    }
  });
  if (!killed) {
    try { child.kill('SIGKILL'); } catch { /* Preserve the original smoke failure. */ }
  }
  const didClose = await waitForClose(closed, closeTimeoutMs);
  if (!didClose) {
    try { child.kill('SIGKILL'); } catch { /* Preserve the original smoke failure. */ }
    const taskkillDetail = taskkillError
      ? `; taskkill failed: ${taskkillError.message}`
      : '';
    throw new Error(
      `Electron process tree did not close within ${closeTimeoutMs} ms${taskkillDetail}`,
    );
  }
}

async function terminateChild(child, closed, {
  closeTimeoutMs = TERMINATION_GRACE_MS,
  platform = process.platform,
  execFileImpl = execFile,
  isClosed = () => false,
  killProcess = process.kill,
} = {}) {
  if (isClosed()) return;
  if (platform === 'win32') {
    await terminateWindowsProcessTree(child, closed, { closeTimeoutMs, execFileImpl });
    return;
  }
  signalChild(child, 'SIGTERM', { killProcess, platform });
  if (await waitForClose(closed, closeTimeoutMs)) return;
  signalChild(child, 'SIGKILL', { killProcess, platform });
  if (await waitForClose(closed, closeTimeoutMs)) return;
  throw new Error(
    `Electron process group did not close within ${closeTimeoutMs} ms after SIGKILL`,
  );
}

function electronLaunch(env, {
  platform = process.platform,
  getuid = () => process.getuid?.(),
} = {}) {
  const electronArgs = [];
  if (platform === 'linux' && getuid() === 0) {
    electronArgs.push('--no-sandbox');
  }
  electronArgs.push(electronRoot);

  if (
    platform === 'linux'
    && !env.DISPLAY
    && !env.WAYLAND_DISPLAY
  ) {
    return {
      command: 'xvfb-run',
      args: ['-a', '--server-args=-screen 0 1280x1024x24', electronExecutable, ...electronArgs],
    };
  }
  return { command: electronExecutable, args: electronArgs };
}

function smokeEnvironment(sourceEnv, userDataPath) {
  const env = {
    ...sourceEnv,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    INEED_SMOKE_HISTORY: 'messages',
    INEED_SMOKE_TEST: '1',
    INEED_SMOKE_USER_DATA: userDataPath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  return env;
}

test('Electron launcher isolates macOS and Linux display strategies', () => {
  assert.deepEqual(electronLaunch({}, { platform: 'darwin', getuid: () => 0 }), {
    command: electronExecutable,
    args: [electronRoot],
  });
  assert.deepEqual(electronLaunch({ DISPLAY: ':99' }, {
    platform: 'linux', getuid: () => 1000,
  }), {
    command: electronExecutable,
    args: [electronRoot],
  });
  assert.deepEqual(electronLaunch({}, { platform: 'linux', getuid: () => 0 }), {
    command: 'xvfb-run',
    args: [
      '-a',
      '--server-args=-screen 0 1280x1024x24',
      electronExecutable,
      '--no-sandbox',
      electronRoot,
    ],
  });
});

test('Electron smoke environment removes inherited runtime entry overrides', () => {
  const env = smokeEnvironment({
    ELECTRON_RUN_AS_NODE: '1',
    KEEP_ME: 'yes',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173',
  }, '/tmp/ineed-smoke-user-data');

  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.VITE_DEV_SERVER_URL, undefined);
  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.INEED_SMOKE_TEST, '1');
  assert.equal(env.INEED_SMOKE_HISTORY, 'messages');
  assert.equal(env.INEED_SMOKE_USER_DATA, '/tmp/ineed-smoke-user-data');
  assert.equal(electronLaunch(env).args.at(-1), electronRoot);
});

test('Windows smoke termination kills the complete process tree and waits for close', async () => {
  const calls = [];
  let resolveClosed;
  const closed = new Promise(resolvePromise => { resolveClosed = resolvePromise; });
  const child = {
    exitCode: null,
    signalCode: null,
    pid: 4242,
    kill: () => calls.push(['fallback-kill']),
  };

  await terminateWindowsProcessTree(child, closed, {
    execFileImpl(command, args, options, callback) {
      calls.push([command, args]);
      assert.deepEqual(options, { timeout: TERMINATION_GRACE_MS, windowsHide: true });
      child.exitCode = 0;
      resolveClosed();
      callback(null);
    },
  });

  assert.deepEqual(calls, [[
    'taskkill', ['/PID', '4242', '/T', '/F'],
  ]]);
});

test('Windows taskkill failure falls back without masking the original failure', async () => {
  const calls = [];
  let resolveClosed;
  const closed = new Promise(resolvePromise => { resolveClosed = resolvePromise; });
  const child = {
    exitCode: null,
    signalCode: null,
    pid: 4343,
    kill(signal) {
      calls.push(['fallback-kill', signal]);
      this.signalCode = signal;
      resolveClosed();
    },
  };

  await assert.doesNotReject(() => terminateWindowsProcessTree(child, closed, {
    execFileImpl(_command, _args, _options, callback) {
      calls.push(['taskkill']);
      callback(new Error('taskkill unavailable'));
    },
  }));
  assert.deepEqual(calls, [['taskkill'], ['fallback-kill', 'SIGKILL']]);
});

test('Windows cleanup terminates the tree when browser exit precedes pipe close', async () => {
  const calls = [];
  let resolveClosed;
  let childClosed = false;
  const closed = new Promise(resolvePromise => { resolveClosed = resolvePromise; });
  const child = {
    exitCode: 0,
    signalCode: null,
    pid: 4444,
    kill: () => calls.push(['fallback-kill']),
  };

  await terminateChild(child, closed, {
    platform: 'win32',
    isClosed: () => childClosed,
    execFileImpl(command, args, _options, callback) {
      calls.push([command, args]);
      childClosed = true;
      resolveClosed();
      callback(null);
    },
  });

  assert.deepEqual(calls, [[
    'taskkill', ['/PID', '4444', '/T', '/F'],
  ]]);
});

test('Windows cleanup rejects when taskkill succeeds but close stays pending', async () => {
  const child = {
    exitCode: 0,
    signalCode: null,
    pid: 4545,
    kill() {},
  };

  await assert.rejects(
    () => terminateWindowsProcessTree(child, new Promise(() => {}), {
      closeTimeoutMs: 5,
      execFileImpl(_command, _args, _options, callback) { callback(null); },
    }),
    /did not close within 5 ms/,
  );
});

test('POSIX cleanup signals a detached group after its leader exits with pipes open', {
  skip: process.platform === 'win32',
  timeout: 5_000,
}, async t => {
  const leaderScript = `
    const { spawn } = require('node:child_process');
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    holder.once('spawn', () => process.exit(0));
    holder.once('error', () => process.exit(2));
  `;
  const child = spawn(process.execPath, ['-e', leaderScript], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  let childClosed = false;
  const closed = new Promise(resolvePromise => {
    child.once('close', () => {
      childClosed = true;
      resolvePromise();
    });
  });
  t.after(async () => {
    if (childClosed || !Number.isInteger(child.pid)) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Best-effort test cleanup. */ }
    await Promise.race([closed.catch(() => {}), delay(1_000)]);
  });

  const leaderExit = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  assert.deepEqual(leaderExit, { code: 0, signal: null });
  assert.equal(child.exitCode, 0);
  assert.equal(childClosed, false);

  await terminateChild(child, closed, {
    closeTimeoutMs: 1_000,
    isClosed: () => childClosed,
  });
  assert.equal(childClosed, true);
});

test('POSIX cleanup rejects when TERM and KILL cannot produce close', async () => {
  const signals = [];
  const child = {
    exitCode: 0,
    signalCode: null,
    pid: 4646,
  };

  await assert.rejects(
    () => terminateChild(child, new Promise(() => {}), {
      closeTimeoutMs: 5,
      isClosed: () => false,
      killProcess(pid, signal) { signals.push([pid, signal]); },
      platform: 'darwin',
    }),
    /did not close within 5 ms/,
  );
  assert.deepEqual(signals, [
    [-4646, 'SIGTERM'],
    [-4646, 'SIGKILL'],
  ]);
});

test('cleanup close gate does not treat a child error as close', async () => {
  assert.equal(
    await waitForClose(Promise.reject(new Error('child error')), 5),
    false,
  );
});

async function runElectronSmoke(userDataPath) {
  const env = smokeEnvironment(process.env, userDataPath);

  const launch = electronLaunch(env);
  const child = spawn(launch.command, launch.args, {
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let outputOverflow = null;
  let earlyTermination = null;
  let earlyCleanupError = null;
  let childClosed = false;
  const collect = target => chunk => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      outputOverflow = new Error(`Electron smoke output exceeded ${MAX_OUTPUT_BYTES} bytes`);
      earlyTermination ||= terminateChild(child, closed, {
        isClosed: () => childClosed,
      }).catch(error => { earlyCleanupError = error; });
      return;
    }
    if (target === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout.on('data', collect('stdout'));
  child.stderr.on('data', collect('stderr'));

  const childError = new Promise((_, reject) => {
    child.once('error', reject);
  });
  const closed = new Promise(resolvePromise => {
    child.once('close', (code, signal) => {
      childClosed = true;
      resolvePromise({ code, signal });
    });
  });
  let timeout;
  let result;
  let primaryError = null;
  try {
    result = await Promise.race([
      closed,
      childError,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(
          new Error(`Electron smoke exceeded ${SMOKE_TIMEOUT_MS} ms`),
        ), SMOKE_TIMEOUT_MS);
      }),
    ]);
    if (outputOverflow) throw outputOverflow;
  } catch (error) {
    primaryError = error;
    error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
  }
  clearTimeout(timeout);
  let cleanupError;
  try {
    await (earlyTermination || terminateChild(child, closed, {
      isClosed: () => childClosed,
    }));
    cleanupError = earlyCleanupError;
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    if (primaryError) primaryError.message += `\ncleanup: ${cleanupError.message}`;
    else throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return { ...result, stderr, stdout };
}

test('built Electron renderer opens and closes history before a clean deterministic exit', {
  timeout: SMOKE_TIMEOUT_MS + TERMINATION_GRACE_MS + 5_000,
}, async t => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'ineed-mqtt-electron-smoke-'));
  t.after(() => rm(userDataPath, { force: true, recursive: true }));

  const result = await runElectronSmoke(userDataPath);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const markerLines = result.stdout.split(/\r?\n/).filter(line => line.startsWith('mqtt-tool-'));

  assert.equal(result.signal, null, combinedOutput);
  assert.equal(result.code, 0, combinedOutput);
  assert.deepEqual(markerLines, [
    'mqtt-tool-ready',
    'mqtt-tool-history-opened',
    'mqtt-tool-history-closed',
  ]);
  assert.doesNotMatch(combinedOutput, /mqtt-tool-runtime-error:/i);
  assert.doesNotMatch(
    combinedOutput,
    /Unable to load preload script|Error occurred in handler|ERR_FILE_NOT_FOUND|Uncaught (?:Exception|ReferenceError|TypeError)|renderer navigation failed|\[Electron\] startup failed:/i,
  );
  await access(join(userDataPath, 'ineed-mqtt.db'), constants.R_OK | constants.W_OK);
});
