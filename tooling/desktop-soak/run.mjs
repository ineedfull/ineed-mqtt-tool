/* global window */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from '@playwright/test';
import mqtt from 'mqtt';
import { startLocalBroker } from '../mqtt-load-test/localBroker.mjs';
import { prepareTauriSoakExecutable } from './tauriExecutable.mjs';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const duration = Number(process.env.SOAK_SECONDS || 1200);
const rate = Number(process.env.SOAK_RATE || 500);
const idleSeconds = Number(process.env.SOAK_IDLE_SECONDS ?? 180);
const keepWindows = process.env.SOAK_KEEP_WINDOWS === '1';
const expectVisible = process.env.SOAK_EXPECT_VISIBLE === '1';
const out = await mkdtemp('/tmp/mqtt-desktop-soak-');
const nativeExecutable = await prepareTauriSoakExecutable(root, out);
console.log(JSON.stringify({ out, duration, rate }));
const driverSource = await readFile(join(root, 'tooling/desktop-soak/rendererDriver.js'), 'utf8');
// Optional diagnosis only; a normal acceptance run never overrides product CSS.
const diagnosticCss = process.env.SOAK_DIAGNOSTIC_CSS || '';
const rendererBlockMs = Number(process.env.SOAK_RENDERER_BLOCK_MS || 0);
assert.ok(Number.isFinite(rendererBlockMs) && rendererBlockMs >= 0 && rendererBlockMs <= 5000, 'Invalid renderer block duration');
const ipcDiagnostic = process.env.SOAK_BLOCK_CUSTOM_IPC === '1' ?
  `const originalFetch = window.fetch.bind(window); window.fetch = (input, ...args) => String(input).startsWith('ipc:') ? Promise.reject(new Error('test-only custom IPC transport diagnosis')) : originalFetch(input, ...args);\n` : '';
const ipcTiming = `window.desktopSoakIpc = { rows: 0, calls: 0, maxMs: 0, totalMs: 0 }; const timedFetch = window.fetch.bind(window);
window.fetch = async (input, options) => { const isSave = String(input).includes('/db_save_messages'); const started = performance.now();
if (isSave) { window.desktopSoakIpc.calls++; try { window.desktopSoakIpc.rows += JSON.parse(options.body).rows.length; } catch {} }
const result = await timedFetch(input, options); if (isSave) { const elapsed = performance.now() - started; window.desktopSoakIpc.maxMs = Math.max(window.desktopSoakIpc.maxMs, elapsed); window.desktopSoakIpc.totalMs += elapsed; } return result; };\n`;
const driver = ipcTiming + ipcDiagnostic + driverSource.replace('async function installDesktopSoak(config) {',
  `async function installDesktopSoak(config) {\nconfig.pauseFollow = ${process.env.SOAK_PAUSE_FOLLOW === '1'};\nconfig.rendererBlockMs = ${rendererBlockMs};\nconst diagnosticStyle = document.createElement('style');\ndiagnosticStyle.textContent = ${JSON.stringify(diagnosticCss)}; document.head.append(diagnosticStyle);`);
const nativeDriverPath = join(out, 'renderer-driver.js');
await writeFile(nativeDriverPath, driver);
const expectedAssets = [];
for (const runtime of ['electron', 'tauri']) {
  const index = await readFile(join(root, `apps/${runtime}/dist/index.html`), 'utf8');
  const scripts = [...index.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.length, `${runtime} production bundle missing`);
  expectedAssets.push(scripts);
}
await writeFile(join(out, 'build-evidence.json'), JSON.stringify({ expectedAssets, diagnosticCss,
  rendererBlockMs, nativeBinarySha256: createHash('sha256').update(await readFile(join(root, 'apps/tauri/src-tauri/target/debug/desktop_soak_harness'))).digest('hex'),
}, null, 2));
const broker = await startLocalBroker();
const publisher = await mqtt.connectAsync(`mqtt://${broker.host}:${broker.port}`, {
  username: broker.username, password: broker.password, clientId: 'desktop-soak-publisher',
});
const env = { ...process.env, INEED_CLIPBOARD_TEST_USER_DATA: join(out, 'electron-profile') };
for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'INEED_SMOKE_TEST']) delete env[key];
let app, native;
// A foreground acceptance run must not become a lock/sleep test mid-run.
// This assertion only prevents idle display sleep; it cannot unlock the Mac.
const displayAwake = expectVisible && process.platform === 'darwin'
  ? spawn('caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' })
  : null;
let nativeWebkitPids = [];
const reports = [], nativeLogs = [], pending = new Map();
let rendererStarted;
let sequence = 0, started;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function nativeCommand(op, minute) {
  const id = `${op}-${minute}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native command timeout ${id}`)); }, 25000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    native.stdin.write(JSON.stringify({ id, op, minute }) + '\n');
  });
}
function processes() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map(row => {
    const m = row.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/); return m && { pid: +m[1], ppid: +m[2], cpuPercent: +m[3], rssKiB: +m[4], command: m[5] };
  }).filter(Boolean);
  const tree = pid => { const ids = new Set([pid]); let added; do { added = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); added = true; } } while (added); return rows.filter(row => ids.has(row.pid)); };
  return { electron: tree(app.process().pid), tauri: tree(native.pid), webkitAssociated: rows.filter(row => nativeWebkitPids.includes(row.pid)), webkitSystem: rows.filter(row => /WebKit/.test(row.command)) };
}
try {
  await mkdir(env.INEED_CLIPBOARD_TEST_USER_DATA);
  app = await electron.launch({ executablePath: await prepareElectronExecutable(), args: [join(root, 'apps/electron/tests/fixtures/clipboardHarness.cjs')], env, timeout: 15000 });
  const page = await app.firstWindow();
  const windowPlacement = await app.evaluate(({ BrowserWindow, screen }, keepVisible) => {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1100, area.width);
    const height = Math.min(800, area.height);
    const window = BrowserWindow.getAllWindows()[0];
    window.setBounds({ x: area.x, y: area.y, width, height });
    window.setAlwaysOnTop(keepVisible);
    if (keepVisible) { window.show(); window.restore(); window.focus(); }
    return { x: area.x + Math.max(0, area.width - width), y: area.y, width, height, area };
  }, expectVisible);
  console.log(JSON.stringify({ event: 'window-placement', ...windowPlacement, expectVisible }));
  page.on('pageerror', error => console.log('ELECTRON_PAGEERROR', error.message));
  await page.waitForSelector('.mqtt-app');
  await page.evaluate(async port => {
    await window.ineedMqtt.db.saveSetting('persistReceiveLogs', 'false');
    await window.ineedMqtt.db.saveConnection({ id: 'desktop-soak', name: 'Desktop Soak', protocol: 'mqtt', host: '127.0.0.1', port,
      username: 'compat-user', password: 'compat-pass', client_id: 'desktop-soak-electron', clean_session: 1, keepalive: 30 });
  }, broker.port);
  await page.reload(); await page.waitForSelector('.conn-item');
  const electronReady = await page.evaluate(`${driver}\ninstallDesktopSoak({runtime:'electron'})`);
  assert.equal(electronReady.ready, true);
  const webkitBefore = new Set(execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').filter(row => /WebKit/.test(row)).map(row => Number(row.trim().split(/\s+/)[0])));
  const ready = new Promise(resolve => pending.set('ready', resolve));
  native = spawn(nativeExecutable, [], {
    env: { ...process.env, INEED_DESKTOP_SOAK_PROFILE: join(out, 'tauri-profile'), INEED_DESKTOP_SOAK_PORT: String(broker.port),
      INEED_DESKTOP_SOAK_DRIVER: nativeDriverPath, INEED_DESKTOP_SOAK_HIDDEN: process.env.SOAK_HIDE_TAURI || '0',
      INEED_DESKTOP_SOAK_WINDOW: JSON.stringify(windowPlacement),
      INEED_DESKTOP_SOAK_KEEP_VISIBLE: expectVisible ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  native.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1); nativeLogs.push(line);
      if (line.startsWith('SOAK ')) { const report = JSON.parse(line.slice(5)); const done = pending.get(report.id); if (done) { pending.delete(report.id); done(report.result); } }
    }
  });
  native.stderr.on('data', chunk => nativeLogs.push(String(chunk)));
  const nativeReady = await Promise.race([ready, wait(25000).then(() => { throw new Error('native ready timeout: ' + nativeLogs.join('\n')); })]);
  assert.equal(nativeReady.ready, true, JSON.stringify(nativeReady));
  if (expectVisible) {
    // Activate after the native event loop and WebView are ready, as with the
    // hidden-window recovery probe; setup-time focus can be overwritten.
    native.stdin.write('SHOW\n');
    await wait(300);
  }
  nativeWebkitPids = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').filter(row => /WebKit/.test(row)).map(row => Number(row.trim().split(/\s+/)[0])).filter(pid => !webkitBefore.has(pid));
  const preflight = await Promise.all([page.evaluate(c => window.desktopSoakCommand(c), { op: 'exercise', minute: 0 }), nativeCommand('exercise', 0)]);
  await writeFile(join(out, 'preflight.json'), JSON.stringify(preflight, null, 2));
  for (const result of preflight) assert.equal(result.failed, undefined, JSON.stringify(result));
  if (expectVisible) {
    for (const snapshot of preflight) {
      assert.equal(snapshot.visibility, 'visible', JSON.stringify(snapshot.nativeWindow));
      assert.ok(snapshot.rootWidth > 0);
    }
  }
  rendererStarted = preflight.map(result => result.started);
  for (const [index, result] of preflight.entries()) {
    for (const asset of expectedAssets[index]) {
      assert.ok(result.assetSources.some(source => source.endsWith(asset.replace(/^\./, ''))),
        `Desktop loaded stale assets: ${JSON.stringify(result.assetSources)}`);
    }
  }
  if (process.env.SOAK_OCCLUDE_TAURI === '1') {
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
  }
  started = Date.now();
  async function settledSnapshots(op, minute) {
    const catchupStarted = Date.now();
    while (true) {
      const snapshots = await Promise.all([
        page.evaluate(c => window.desktopSoakCommand(c), { op, minute }), nativeCommand(op, minute),
      ]);
      snapshots[0].nativeWindow = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), bounds: window.getBounds() };
      });
      for (const [index, result] of snapshots.entries()) {
        assert.equal(result.failed, undefined, JSON.stringify(result));
        assert.equal(result.started, rendererStarted[index], 'Desktop renderer reloaded');
      }
      if (snapshots.every(result => result.received === sequence && result.historyTotal === sequence)) {
        if (process.env.SOAK_PAUSE_FOLLOW !== '1') {
          for (const snapshot of snapshots) {
            assert.equal(snapshot.followingLatest, true, 'Live viewport unexpectedly paused');
            assert.equal(snapshot.latestRenderedSequence, sequence, 'Live viewport did not show the latest message');
            assert.ok(snapshot.domMessages > 0 && snapshot.domMessages < 30,
              `Live viewport rendered ${snapshot.domMessages} rows`);
          }
        }
        return { snapshots, catchupWaitMs: Date.now() - catchupStarted };
      }
      assert.ok(Date.now() - catchupStarted < 10_000,
        `History failed to drain in 10 seconds: ${JSON.stringify(snapshots.map(result => ({ received: result.received, saved: result.historyTotal, sent: sequence })))}`);
      await wait(100);
      op = 'snapshot';
    }
  }
  console.log(JSON.stringify({ event: 'started', electronPid: app.process().pid, tauriPid: native.pid, out, time: new Date().toISOString() }));
  let nextExercise = 60, minute = 0;
  while (Date.now() - started < duration * 1000) {
    const before = Date.now();
    await Promise.all(Array.from({ length: Math.round(rate / 5) }, () => {
      sequence++;
      return publisher.publishAsync('desktop-soak/data', JSON.stringify({ seq: sequence, text: '压力测试<svg onload=alert(1)>', padding: 'x'.repeat(160) }), { qos: 1 });
    }));
    await wait(Math.max(0, 200 - (Date.now() - before)));
    if ((Date.now() - started) / 1000 >= nextExercise) {
      minute++; await wait(1200);
      const { snapshots: [e, t], catchupWaitMs } = await settledSnapshots('exercise', minute);
      const report = { minute, elapsedMs: Date.now() - started, catchupWaitMs, sent: sequence, electron: e, tauri: t, memory: processes() };
      try {
        await page.screenshot({ path: join(out, `electron-minute-${minute}.png`), timeout: 3000, animations: 'disabled' });
      } catch (error) {
        // Capture is evidence collection. A compositor capture timeout must not
        // discard the independent data, visibility and process measurements.
        report.screenshotError = String(error.message);
      }
      reports.push(report); await writeFile(join(out, 'samples.json'), JSON.stringify(reports, null, 2));
      console.log(JSON.stringify({ event: 'minute', ...report }));
      assert.equal(e.failed, undefined); assert.equal(t.failed, undefined);
      assert.equal(e.received, sequence); assert.equal(t.received, sequence);
      assert.equal(e.started, rendererStarted[0]); assert.equal(t.started, rendererStarted[1]);
      if (expectVisible) {
        for (const snapshot of [e, t]) {
          assert.equal(snapshot.visibility, 'visible', 'Resource acceptance requires a visible desktop window');
          assert.ok(snapshot.rootWidth > 0, 'Visible workbench layout must remain active');
          assert.equal(snapshot.nativeWindow.visible, true, 'Native window must remain visible');
          assert.equal(snapshot.nativeWindow.minimized, false, 'Native window must not be minimized');
          assert.deepEqual(snapshot.visibilityEvents.filter(event => event.visibility !== 'visible' && event.received > 0), [],
            'Foreground load must not switch to a hidden page between samples');
        }
      }
      assert.equal(e.historyTotal, sequence, 'Electron history did not catch up after publishing paused');
      assert.equal(t.historyTotal, sequence, 'Tauri history did not catch up after publishing paused');
      assert.equal(e.gaps + e.duplicates + e.invalidPayload, 0); assert.equal(t.gaps + t.duplicates + t.invalidPayload, 0);
      nextExercise += 60;
    }
  }
  const idleReports = [];
  const idleStarted = Date.now();
  while (Date.now() - idleStarted < idleSeconds * 1000) {
    await wait(Math.min(10000, idleSeconds * 1000 - (Date.now() - idleStarted)));
    const [e, t] = await Promise.all([
      page.evaluate(c => window.desktopSoakCommand(c), { op: 'snapshot' }), nativeCommand('snapshot', 99),
    ]);
    const sample = { idleSeconds: Math.round((Date.now() - idleStarted) / 1000), sent: sequence,
      electron: e, tauri: t, memory: processes() };
    idleReports.push(sample);
    await writeFile(join(out, 'idle-samples.json'), JSON.stringify(idleReports, null, 2));
    console.log(JSON.stringify({ event: 'idle-sample', ...sample }));
    for (const [index, result] of [e, t].entries()) {
      assert.equal(result.failed, undefined);
      assert.equal(result.started, rendererStarted[index], 'WebView reloaded during idle observation');
      assert.equal(result.received, sequence);
      assert.equal(result.historyTotal, sequence);
      assert.deepEqual(result.errors, []);
    }
  }
  await wait(1500);
  let foregroundRecovery;
  if (process.env.SOAK_HIDE_TAURI === '1') {
    native.stdin.write('SHOW\n');
    const deadline = Date.now() + 10_000;
    do {
      await wait(200);
      foregroundRecovery = await nativeCommand('snapshot', 100);
      assert.equal(foregroundRecovery.started, rendererStarted[1]);
      assert.ok(Date.now() < deadline, 'Tauri workbench did not recover when shown');
    } while (foregroundRecovery.visibility !== 'visible' || foregroundRecovery.rootWidth === 0);
    assert.equal(foregroundRecovery.received, sequence);
    assert.equal(foregroundRecovery.latestRenderedSequence, sequence);
  }
  // Check the stored sequence set before cleanup, independently of renderer
  // counters. Equal row counts alone could hide a duplicate plus a missing row.
  const databaseSequences = {};
  for (const runtime of ['electron', 'tauri']) {
    const database = new DatabaseSync(join(out, `${runtime}-profile/ineed-mqtt.db`), { readOnly: true });
    try {
      const stored = database.prepare(`WITH sequences AS (
        SELECT CASE WHEN json_valid(payload) THEN json_extract(payload, '$.seq') END AS seq
        FROM message_history WHERE connection_id = 'desktop-soak' AND direction = 'in'
      ) SELECT count(*) AS rows, count(DISTINCT seq) AS distinctSequences,
        min(seq) AS minSequence, max(seq) AS maxSequence,
        sum(typeof(seq) <> 'integer') AS invalidSequences FROM sequences`).get();
      const quickCheck = Object.values(database.prepare('PRAGMA quick_check').get())[0];
      databaseSequences[runtime] = { ...stored, quickCheck };
      assert.equal(stored.rows, sequence);
      assert.equal(stored.distinctSequences, sequence);
      assert.equal(stored.minSequence, 1);
      assert.equal(stored.maxSequence, sequence);
      assert.equal(stored.invalidSequences, 0);
      assert.equal(quickCheck, 'ok');
    } finally { database.close(); }
  }
  await writeFile(join(out, 'history-sequences.json'), JSON.stringify(databaseSequences, null, 2));
  const [e, t] = await Promise.all([page.evaluate(c => window.desktopSoakCommand(c), { op: 'finish', minute }), nativeCommand('finish', minute)]);
  const result = { durationSeconds: duration, elapsedMs: Date.now() - started, sent: sequence, electron: e, tauri: t, databaseSequences, memory: processes(), samples: reports.length, idleSamples: idleReports.length, idleSeconds, diagnosticCss, foregroundRecovery };
  for (const r of [e, t]) { assert.equal(r.failed, undefined); assert.equal(r.received, sequence); assert.equal(r.gaps + r.duplicates + r.invalidPayload, 0); assert.deepEqual(r.errors, []); assert.equal(r.finalCounts[0].messages_in, sequence); assert.deepEqual(r.afterCleanup, []); }
  const passed = true;
  await writeFile(join(out, 'result.json'), JSON.stringify({ ...result, passed, expectVisible, keepWindows }, null, 2));
  console.log(JSON.stringify({ event: 'finished', ...result, passed, expectVisible, keepWindows }));
} catch (error) {
  await writeFile(join(out, 'failure.txt'), String(error.stack)); console.error(error); process.exitCode = 1;
} finally {
  await writeFile(join(out, 'tauri-native.log'), nativeLogs.join('\n'));
  const windowsRetained = keepWindows;
  if (!windowsRetained) {
    if (native) { native.stdin.write('EXIT\n'); await wait(700); if (native.exitCode === null) native.kill(); }
    await app?.close();
  }
  await publisher.endAsync(true); await broker.close();
  displayAwake?.kill();
  console.log(JSON.stringify({ event: 'cleanup', brokerSockets: broker.openSocketCount, brokerClosed: broker.isClosed, windowsRetained, out }));
  if (windowsRetained) {
    // Keep the driver attached while the user inspects the two test windows.
    console.log(JSON.stringify({ event: 'windows-retained', out }));
  }
}
