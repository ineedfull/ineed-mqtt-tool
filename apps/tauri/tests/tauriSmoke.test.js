import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(TEST_DIR, '..');
const REPOSITORY_ROOT = resolve(APP_DIR, '..', '..');
const TAURI_DIR = join(APP_DIR, 'src-tauri');
const BINARY_NAME = 'ineed-mqtt-tool';
const SMOKE_TIMEOUT_MS = readPositiveInteger(
  process.env.INEED_TAURI_SMOKE_TIMEOUT_MS,
  60_000,
);
const BUILD_TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_BUILD_OUTPUT_BYTES = 16 * 1_048_576;
const FORBIDDEN_STDERR_PATTERN = /panic|thread .* panicked|missing command|command not found|not allowed|denied capability|runtime[- ]adapter|adapter was not provided|mqtt-tool-renderer-error|page load failure/iu;
const REQUIRED_TABLES = [
  'connections',
  'logs',
  'message_history',
  'publish_history',
  'settings',
  'subscriptions',
];
const EXPECTED_MARKERS = [
  'mqtt-tool-database-path:isolated-smoke-profile',
  'mqtt-tool-database-initialized',
  'mqtt-tool-ready',
  'mqtt-tool-shutdown',
  'mqtt-tool-closed',
  'mqtt-tool-default-profile-unchanged',
];

function readPositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(milliseconds) {
  return new Promise(resolvePromise => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
  });
}

function tauriLaunch(binaryPath, env, { platform = process.platform } = {}) {
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return {
      command: 'xvfb-run',
      args: ['-a', '--server-args=-screen 0 1280x1024x24', binaryPath],
    };
  }
  return { command: binaryPath, args: [] };
}

function smokeEnvironment(sourceEnv, appDataPath, {
  platform = process.platform,
  getuid = () => process.getuid?.(),
} = {}) {
  const env = {
    ...sourceEnv,
    INEED_SMOKE_APP_DATA: appDataPath,
    INEED_SMOKE_TEST: '1',
  };
  for (const name of [
    'ELECTRON_RUN_AS_NODE',
    'TAURI_CONFIG',
    'TAURI_DEV',
    'TAURI_ENV_DEBUG',
    'TAURI_ENV_PLATFORM',
    'TAURI_PLATFORM',
    'VITE_DEV_SERVER_URL',
    'INEED_SMOKE_DISABLE_RENDERER_READY',
    'INEED_SMOKE_FAULT',
    'INEED_SMOKE_PAGE_LOAD_TIMEOUT_MS',
  ]) {
    delete env[name];
  }
  if (platform === 'linux' && getuid() === 0) {
    env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS = '1';
  } else {
    delete env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS;
  }
  return env;
}

function smokeBuildEnvironment(sourceEnv) {
  return {
    ...sourceEnv,
    TAURI_CONFIG: '{"build":{"devUrl":null}}',
  };
}

function packageManagerExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function execBuild(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      cwd: REPOSITORY_ROOT,
      maxBuffer: MAX_BUILD_OUTPUT_BYTES,
      timeout: BUILD_TIMEOUT_MS,
      windowsHide: true,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        reject(error);
        return;
      }
      resolvePromise({ stderr, stdout });
    });
  });
}

function cargoExecutableFromJson(output) {
  const executables = [];
  for (const line of output.split(/\r?\n/u)) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message?.reason !== 'compiler-artifact'
      || message.target?.name !== BINARY_NAME
      || !message.target.kind?.includes('bin')
      || typeof message.executable !== 'string') {
      continue;
    }
    if (!isAbsolute(message.executable)) {
      throw new Error(`Cargo binary executable must be absolute: ${message.executable}`);
    }
    executables.push(message.executable);
  }
  if (executables.length !== 1) {
    throw new Error(`Cargo build must report exactly one ${BINARY_NAME} executable`);
  }
  return executables[0];
}

function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function buildSmokeArtifacts({ environment = process.env } = {}) {
  await execBuild(packageManagerExecutable(), [
    'run',
    'build',
    '-w',
    '@ineed-mqtt-tool/tauri',
  ]);
  const buildStartedAt = Date.now();
  const cargo = await execBuild('cargo', [
    'build',
    '--locked',
    '--message-format=json-render-diagnostics',
    '--manifest-path',
    'apps/tauri/src-tauri/Cargo.toml',
  ], { env: smokeBuildEnvironment(environment) });
  const binaryPath = cargoExecutableFromJson(cargo.stdout);
  const binary = await stat(binaryPath);
  assert.equal(binary.isFile(), true, binaryPath);
  assert.ok(binary.size > 0, `${binaryPath} must not be empty`);
  await access(binaryPath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  const binaryHash = await hashFile(binaryPath);
  assert.match(binaryHash, /^[0-9a-f]{64}$/u);
  return { binaryHash, binaryPath, buildStartedAt, modifiedAt: binary.mtimeMs };
}

let defaultSmokeArtifactsPromise;

function defaultSmokeArtifacts() {
  defaultSmokeArtifactsPromise ||= buildSmokeArtifacts();
  return defaultSmokeArtifactsPromise;
}

async function rustHostTriple() {
  const { stdout } = await execBuild('rustc', ['-vV']);
  const host = /^host:\s*(\S+)$/mu.exec(stdout)?.[1];
  assert.ok(host, `rustc did not report a host triple:\n${stdout}`);
  return host;
}

async function createSmokeAppDataDirectory(context, {
  makeDirectory = mkdtemp,
  removeDirectory = path => rm(path, { force: true, recursive: true }),
  temporaryDirectory = tmpdir(),
} = {}) {
  const prefix = join(resolve(temporaryDirectory), 'ineed-mqtt-tauri-smoke-');
  const directory = resolve(await makeDirectory(prefix));
  context.after(() => removeDirectory(directory));
  return directory;
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
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    if (await waitForClose(closed, closeTimeoutMs)) return;
    throw new Error(`Tauri child pipes did not close within ${closeTimeoutMs} ms`);
  }
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
    } catch (error) {
      taskkillError = error;
      resolvePromise(false);
    }
  });
  if (!killed) {
    try { child.kill('SIGKILL'); } catch { /* Preserve the primary smoke failure. */ }
  }
  if (await waitForClose(closed, closeTimeoutMs)) return;
  try { child.kill('SIGKILL'); } catch { /* Preserve the hard close-gate error. */ }
  const taskkillDetail = taskkillError ? `; taskkill failed: ${taskkillError.message}` : '';
  throw new Error(
    `Tauri process tree did not close within ${closeTimeoutMs} ms${taskkillDetail}`,
  );
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
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    if (await waitForClose(closed, closeTimeoutMs)) return;
    throw new Error(`Tauri child pipes did not close within ${closeTimeoutMs} ms`);
  }
  signalChild(child, 'SIGTERM', { killProcess, platform });
  if (await waitForClose(closed, closeTimeoutMs)) return;
  signalChild(child, 'SIGKILL', { killProcess, platform });
  if (await waitForClose(closed, closeTimeoutMs)) return;
  throw new Error(
    `Tauri process group did not close within ${closeTimeoutMs} ms after SIGKILL`,
  );
}

async function runTauriSmoke(appDataPath, { binaryPath, environment = {} } = {}) {
  if (!isAbsolute(binaryPath)) throw new TypeError('built Tauri binary path must be absolute');
  const env = { ...smokeEnvironment(process.env, appDataPath), ...environment };
  const launch = tauriLaunch(binaryPath, env);
  const child = spawn(launch.command, launch.args, {
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let outputOverflow = null;
  let earlyTermination = null;
  let earlyCleanupError = null;
  let childClosed = false;
  const closed = new Promise(resolvePromise => {
    child.once('close', (code, signal) => {
      childClosed = true;
      resolvePromise({ code, signal });
    });
  });
  const collect = target => chunk => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      outputOverflow = new Error(`Tauri smoke output exceeded ${MAX_OUTPUT_BYTES} bytes`);
      child.stdout.pause();
      child.stderr.pause();
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

  const childError = new Promise((_, reject) => child.once('error', reject));
  let timeout;
  let result;
  let primaryError = null;
  try {
    result = await Promise.race([
      closed,
      childError,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(
          new Error(`Tauri smoke exceeded ${SMOKE_TIMEOUT_MS} ms`),
        ), SMOKE_TIMEOUT_MS);
      }),
    ]);
    if (outputOverflow) throw outputOverflow;
  } catch (error) {
    primaryError = error;
    error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
  } finally {
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
    child.stdout.destroy();
    child.stderr.destroy();
    if (cleanupError) {
      if (primaryError) primaryError.message += `\ncleanup: ${cleanupError.message}`;
      else primaryError = cleanupError;
    }
  }
  if (primaryError) throw primaryError;
  return { ...result, binaryPath, stderr, stdout };
}

async function assertBuiltArtifacts(binaryPath) {
  const manifest = await readFile(join(TAURI_DIR, 'Cargo.toml'), 'utf8');
  assert.match(manifest, /\[package\][\s\S]*?name\s*=\s*"ineed-mqtt-tool"/u);
  assert.match(manifest, /\[package\][\s\S]*?version\s*=\s*"0\.1\.0"/u);

  const binary = await stat(binaryPath);
  assert.equal(binary.isFile(), true, binaryPath);
  assert.ok(binary.size > 0, `${binaryPath} must not be empty`);
  await access(binaryPath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);

  const indexPath = join(APP_DIR, 'dist', 'index.html');
  const index = await readFile(indexPath, 'utf8');
  const assetPaths = [...index.matchAll(/(?:src|href)="\.\/([^"?#]+)"/gu)]
    .map(match => match[1]);
  assert.ok(assetPaths.some(path => path.endsWith('.js')), 'built index must load JavaScript');
  assert.ok(assetPaths.some(path => path.endsWith('.css')), 'built index must load CSS');
  for (const assetPath of assetPaths) {
    const asset = await stat(join(APP_DIR, 'dist', assetPath));
    assert.equal(asset.isFile(), true, assetPath);
    assert.ok(asset.size > 0, `${assetPath} must not be empty`);
  }
  if (process.platform !== 'win32') {
    const binaryStrings = await execBuild('strings', [binaryPath]);
    assert.doesNotMatch(binaryStrings.stdout, /http:\/\/localhost:5175/u);
    for (const assetPath of assetPaths) {
      assert.match(binaryStrings.stdout, new RegExp(`/${assetPath.replaceAll('.', '\\.')}`, 'u'));
    }
  }
  const distEntries = await readdir(join(APP_DIR, 'dist'));
  assert.deepEqual([...distEntries].sort(), ['assets', 'index.html']);
}

function assertDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name);
    assert.deepEqual(tables, REQUIRED_TABLES);
  } finally {
    database.close();
  }
}

test('Linux headless launch uses the Cargo-reported executable', () => {
  assert.deepEqual(tauriLaunch('/target/debug/app', {}, { platform: 'linux' }), {
    command: 'xvfb-run',
    args: ['-a', '--server-args=-screen 0 1280x1024x24', '/target/debug/app'],
  });
  assert.deepEqual(
    tauriLaunch('/target/debug/app', { DISPLAY: ':99' }, { platform: 'linux' }),
    { command: '/target/debug/app', args: [] },
  );
});

test('Cargo JSON discovers exactly one absolute executable amid noise and library artifacts', () => {
  const executable = resolve('target', 'debug', BINARY_NAME);
  const output = [
    'Compiling diagnostic noise that is not JSON',
    JSON.stringify({
      executable: null,
      reason: 'compiler-artifact',
      target: { kind: ['lib'], name: 'ineed_mqtt_tool_lib' },
    }),
    JSON.stringify({ reason: 'build-script-executed', package_id: 'dependency 1.0.0' }),
    JSON.stringify({
      executable,
      reason: 'compiler-artifact',
      target: { kind: ['bin'], name: BINARY_NAME },
    }),
  ].join('\n');

  assert.equal(cargoExecutableFromJson(output), executable);
});

test('Cargo JSON rejects missing duplicate and relative binary executables', () => {
  const artifact = executable => JSON.stringify({
    executable,
    reason: 'compiler-artifact',
    target: { kind: ['bin'], name: BINARY_NAME },
  });

  assert.throws(() => cargoExecutableFromJson('not-json'), /exactly one/u);
  assert.throws(
    () => cargoExecutableFromJson([artifact('/first/app'), artifact('/second/app')].join('\n')),
    /exactly one/u,
  );
  assert.throws(
    () => cargoExecutableFromJson(artifact(join('target', 'debug', BINARY_NAME))),
    /absolute/u,
  );
});

test('root Tauri verification runs one real smoke after all serial quality gates', async () => {
  const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts['test:tauri'], [
    'node --test',
    'apps/tauri/tests/databaseContract.test.js',
    'apps/tauri/tests/mqttContract.test.js',
    'apps/tauri/tests/runtimeAdapter.test.js',
    'apps/tauri/tests/readinessReporter.test.js',
    'apps/tauri/tests/tauriBoundary.test.js',
  ].join(' '));
  assert.equal(
    packageJson.scripts['test:tauri:smoke'],
    'node --test apps/tauri/tests/tauriSmoke.test.js',
  );
  assert.equal(packageJson.scripts['verify:tauri'], [
    'npm run test:shared',
    'npm run test:tauri',
    'npm run lint',
    'npm run build -w @ineed-mqtt-tool/tauri',
    'cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml -- --check',
    'cargo check --locked --manifest-path apps/tauri/src-tauri/Cargo.toml',
    'cargo test --locked --manifest-path apps/tauri/src-tauri/Cargo.toml',
    'cargo build --locked --manifest-path apps/tauri/src-tauri/Cargo.toml',
    'npm run test:tauri:smoke',
    'git diff --check',
  ].join(' && '));
  assert.equal(packageJson.scripts['verify:tauri'].match(/test:tauri:smoke/gu)?.length, 1);
});

test('native smoke lifecycle reports a bounded main renderer page-load failure', async () => {
  const source = await readFile(join(TAURI_DIR, 'src', 'lib.rs'), 'utf8');

  assert.match(source, /PageLoadEvent::Started/u);
  assert.match(source, /Duration::from_secs\(30\)/u);
  assert.match(source, /mqtt-tool-page-load-failure: main renderer did not finish handshake/u);
  assert.match(source, /app:renderer-ready/u);
  assert.match(source, /app:renderer-error/u);
  assert.match(source, /mqtt-tool-default-profile-unchanged/u);
  assert.doesNotMatch(source, /PageLoadEvent::Finished[\s\S]{0,300}mqtt-tool-ready/u);
});

test('smoke environment isolates app data and removes runtime entry overrides', () => {
  const env = smokeEnvironment({
    ELECTRON_RUN_AS_NODE: '1',
    KEEP_ME: 'yes',
    INEED_SMOKE_FAULT: 'vue-lifecycle',
    TAURI_DEV: '1',
    TAURI_CONFIG: '{"build":{"devUrl":"http://127.0.0.1:9999"}}',
    TAURI_ENV_DEBUG: 'true',
    TAURI_ENV_PLATFORM: 'darwin',
    TAURI_PLATFORM: 'darwin',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5175',
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: 'inherited',
  }, '/absolute/smoke-profile', { platform: 'darwin' });

  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.INEED_SMOKE_APP_DATA, '/absolute/smoke-profile');
  assert.equal(env.INEED_SMOKE_TEST, '1');
  assert.equal(env.INEED_SMOKE_FAULT, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.TAURI_DEV, undefined);
  assert.equal(env.TAURI_CONFIG, undefined);
  assert.equal(env.TAURI_ENV_DEBUG, undefined);
  assert.equal(env.TAURI_ENV_PLATFORM, undefined);
  assert.equal(env.TAURI_PLATFORM, undefined);
  assert.equal(env.VITE_DEV_SERVER_URL, undefined);
  assert.equal(env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS, undefined);

  const linuxRootEnv = smokeEnvironment({}, '/absolute/smoke-profile', {
    getuid: () => 0,
    platform: 'linux',
  });
  assert.equal(linuxRootEnv.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS, '1');
});

test('smoke build environment embeds frontendDist in the debug binary', () => {
  const env = smokeBuildEnvironment({ KEEP_ME: 'yes', TAURI_CONFIG: '{"other":true}' });

  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.TAURI_CONFIG, '{"build":{"devUrl":null}}');
  assert.equal(packageManagerExecutable('darwin'), 'npm');
  assert.equal(packageManagerExecutable('win32'), 'npm.cmd');
});

test('smoke temp path resolves relative TMPDIR and registers cleanup before later work', async () => {
  const calls = [];
  let cleanup;
  const context = {
    after(handler) {
      calls.push('registered');
      cleanup = handler;
    },
  };

  const directory = await createSmokeAppDataDirectory(context, {
    makeDirectory: async prefix => {
      calls.push(['created', prefix]);
      return join(resolve('relative-tmp'), 'profile');
    },
    removeDirectory: async path => calls.push(['removed', path]),
    temporaryDirectory: 'relative-tmp',
  });
  assert.equal(directory, join(resolve('relative-tmp'), 'profile'));
  assert.deepEqual(calls.slice(0, 2), [
    ['created', join(resolve('relative-tmp'), 'ineed-mqtt-tauri-smoke-')],
    'registered',
  ]);

  const earlyFailure = new Error('fingerprint failed after temp creation');
  await assert.rejects(async () => {
    assert.equal(typeof cleanup, 'function');
    throw earlyFailure;
  }, earlyFailure);
  await cleanup();
  assert.deepEqual(calls.at(-1), ['removed', directory]);
});

test('stderr gate rejects every runtime adapter and renderer error spelling', () => {
  for (const diagnostic of [
    'runtime-adapter error',
    'runtime adapter error',
    'Adapter was not provided',
    'mqtt-tool-renderer-error:unhandledrejection:Error',
  ]) {
    assert.match(diagnostic, FORBIDDEN_STDERR_PATTERN, diagnostic);
  }
});

test('Windows cleanup kills the complete process tree and waits for close', async () => {
  const calls = [];
  let resolveClosed;
  const closed = new Promise(resolvePromise => { resolveClosed = resolvePromise; });
  const child = { pid: 4242, kill: signal => calls.push(['fallback', signal]) };

  await terminateWindowsProcessTree(child, closed, {
    execFileImpl(command, args, options, callback) {
      calls.push([command, args, options]);
      resolveClosed();
      callback(null);
    },
  });

  assert.deepEqual(calls, [[
    'taskkill',
    ['/PID', '4242', '/T', '/F'],
    { timeout: TERMINATION_GRACE_MS, windowsHide: true },
  ]]);
});

test('Windows taskkill failure falls back and still requires close', async () => {
  const calls = [];
  let resolveClosed;
  const closed = new Promise(resolvePromise => { resolveClosed = resolvePromise; });
  const child = {
    pid: 4343,
    kill(signal) {
      calls.push(['fallback', signal]);
      resolveClosed();
    },
  };

  await terminateWindowsProcessTree(child, closed, {
    execFileImpl(_command, _args, _options, callback) {
      calls.push(['taskkill']);
      callback(new Error('taskkill unavailable'));
    },
  });
  assert.deepEqual(calls, [['taskkill'], ['fallback', 'SIGKILL']]);
});

test('Windows cleanup rejects when taskkill succeeds but pipes stay open', async () => {
  const child = { pid: 4444, kill() {} };
  await assert.rejects(
    () => terminateWindowsProcessTree(child, new Promise(() => {}), {
      closeTimeoutMs: 5,
      execFileImpl(_command, _args, _options, callback) { callback(null); },
    }),
    /did not close within 5 ms/u,
  );
});

test('POSIX cleanup signals a detached group whose leader exited with pipes open', {
  skip: process.platform === 'win32',
  timeout: 5_000,
}, async t => {
  const leaderScript = `
    const { spawn } = require('node:child_process');
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
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
    await Promise.race([closed, delay(1_000)]);
  });

  const leaderExit = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  assert.deepEqual(leaderExit, { code: 0, signal: null });
  assert.equal(childClosed, false);

  await terminateChild(child, closed, {
    closeTimeoutMs: 1_000,
    isClosed: () => childClosed,
  });
  assert.equal(childClosed, true);
});

test('POSIX cleanup rejects when TERM and KILL cannot close pipes', async () => {
  const signals = [];
  const child = { pid: 4545 };
  await assert.rejects(
    () => terminateChild(child, new Promise(() => {}), {
      closeTimeoutMs: 5,
      isClosed: () => false,
      killProcess(pid, signal) { signals.push([pid, signal]); },
      platform: 'darwin',
    }),
    /did not close within 5 ms after SIGKILL/u,
  );
  assert.deepEqual(signals, [
    [-4545, 'SIGTERM'],
    [-4545, 'SIGKILL'],
  ]);
});

test('built Tauri renderer and isolated database close with a clean deterministic exit', {
  timeout: (2 * BUILD_TIMEOUT_MS) + SMOKE_TIMEOUT_MS
    + (2 * TERMINATION_GRACE_MS) + 10_000,
}, async t => {
  const artifacts = await defaultSmokeArtifacts();
  await assertBuiltArtifacts(artifacts.binaryPath);
  const appDataPath = await createSmokeAppDataDirectory(t);
  const databasePath = join(appDataPath, 'ineed-mqtt.db');

  const result = await runTauriSmoke(appDataPath, { binaryPath: artifacts.binaryPath });
  const markerLines = result.stdout
    .split(/\r?\n/u)
    .filter(line => line.startsWith('mqtt-tool-'));
  const output = `binary: ${result.binaryPath}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

  assert.equal(result.signal, null, output);
  assert.equal(result.code, 0, output);
  assert.deepEqual(markerLines, EXPECTED_MARKERS, output);
  assert.doesNotMatch(
    result.stderr,
    FORBIDDEN_STDERR_PATTERN,
  );
  await access(databasePath, constants.R_OK | constants.W_OK);
  assertDatabase(databasePath);
});

test('native watchdog exits nonzero when renderer readiness is fault-disabled', {
  timeout: 15_000,
}, async t => {
  const appDataPath = await createSmokeAppDataDirectory(t);
  const artifacts = await defaultSmokeArtifacts();
  const result = await runTauriSmoke(appDataPath, {
    binaryPath: artifacts.binaryPath,
    environment: {
      INEED_SMOKE_DISABLE_RENDERER_READY: '1',
      INEED_SMOKE_PAGE_LOAD_TIMEOUT_MS: '500',
    },
  });
  const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

  assert.equal(result.signal, null, output);
  assert.equal(result.code, 1, output);
  assert.match(result.stderr, /mqtt-tool-page-load-failure: main renderer did not finish handshake/iu);
  assert.doesNotMatch(result.stdout, /mqtt-tool-ready/u);
});

test('Vue lifecycle fault is reported and cannot race renderer readiness', {
  timeout: 15_000,
}, async t => {
  const appDataPath = await createSmokeAppDataDirectory(t);
  const artifacts = await defaultSmokeArtifacts();
  const result = await runTauriSmoke(appDataPath, {
    binaryPath: artifacts.binaryPath,
    environment: { INEED_SMOKE_FAULT: 'vue-lifecycle' },
  });
  const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

  assert.equal(result.signal, null, output);
  assert.equal(result.code, 1, output);
  assert.match(result.stderr, /mqtt-tool-renderer-error:vue:Error/iu);
  assert.doesNotMatch(result.stdout, /mqtt-tool-ready/u);
});

test('Cargo host-target build launches its reported fresh executable', {
  timeout: (2 * BUILD_TIMEOUT_MS) + SMOKE_TIMEOUT_MS
  + (2 * TERMINATION_GRACE_MS) + 10_000,
}, async t => {
  const host = await rustHostTriple();
  const targetedArtifacts = await buildSmokeArtifacts({
    environment: { ...process.env, CARGO_BUILD_TARGET: host },
  });
  assert.match(targetedArtifacts.binaryPath, new RegExp(host.replaceAll('.', '\\.'), 'u'));
  const appDataPath = await createSmokeAppDataDirectory(t);
  const result = await runTauriSmoke(appDataPath, {
    binaryPath: targetedArtifacts.binaryPath,
  });
  const markerLines = result.stdout
    .split(/\r?\n/u)
    .filter(line => line.startsWith('mqtt-tool-'));
  const output = `binary: ${result.binaryPath}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

  assert.equal(result.signal, null, output);
  assert.equal(result.code, 0, output);
  assert.deepEqual(markerLines, EXPECTED_MARKERS, output);
  assert.equal(result.stderr, '', output);
});
