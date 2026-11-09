import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { _electron as electron, expect } from '@playwright/test';

test('sandboxed Electron copies through the native clipboard in main and history windows', { timeout: 45_000 }, async t => {
  const userData = await mkdtemp(join(tmpdir(), 'mqtt-clipboard-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const env = { ...process.env, INEED_CLIPBOARD_TEST_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  delete env.INEED_SMOKE_TEST;
  const app = await electron.launch({
    args: [fileURLToPath(new URL('./fixtures/clipboardHarness.cjs', import.meta.url))],
    env,
    timeout: 15_000,
  });
  t.after(async () => {
    try {
      await app.evaluate(({ clipboard }) => {
        const saved = globalThis.__clipboardTestSaved;
        if (saved) {
          clipboard.clear();
          for (const [format, buffer] of saved) clipboard.writeBuffer(format, buffer);
        }
      });
    } finally {
      await app.close();
    }
  });
  await app.evaluate(({ clipboard }) => {
    globalThis.__clipboardTestSaved = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
  });
  const page = await app.firstWindow();
  await expect(page.getByText('暂无连接', { exact: true })).toBeVisible();
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);

  // This crossed the real sandbox boundary incorrectly before the regression fix.
  await page.evaluate(() => globalThis.ineedMqtt.clipboard.writeText('MQTT 原生复制\n✓'));
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'MQTT 原生复制\n✓');
  assert.equal(await page.evaluate(() => globalThis.ineedMqtt.clipboard.readText()), 'MQTT 原生复制\n✓');

  await page.evaluate(async () => {
    const db = globalThis.ineedMqtt.db;
    await db.saveConnection({ id: 'copy-test', name: 'Copy Test', host: 'localhost', port: 1883, protocol: 'mqtt' });
    await db.addSubscription({ id: 'copy-sub', connection_id: 'copy-test', topic: 'copy/测试/#', qos: 0, format: 'text' });
    await db.saveMessages([{ id: 'copy-message', connection_id: 'copy-test', direction: 'in', topic: 'copy/测试/1', payload: '原始消息\n第二行', qos: 0, time: '2026-09-21 10:00:00' }]);
    await db.saveLogs([{ id: 'copy-log', connection_id: 'copy-test', level: 'info', msg: '复制测试日志', time: '2026-09-21 10:00:00' }]);
  });
  await page.reload();
  await expect(page.locator('.subscription-panel__connection')).toHaveText('Copy Test');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('mqtt:messages', [{
      connId: 'copy-test', topic: 'copy/测试/1', payload: '实时消息\n第二行',
      qos: 0, retained: false, timestamp: Date.now(),
    }]);
  });
  await page.getByRole('button', { name: '复制消息', exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('实时消息\n第二行');
  await page.getByTitle('复制订阅主题', { exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('copy/测试/#');
  await page.getByPlaceholder('输入目标 Topic...').fill('copy/发送/1');
  await page.getByTitle('复制发送 Topic', { exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('copy/发送/1');

  await page.locator('.publish-bar').getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.cm-content').fill('发送内容\n中文 ✓');
  await page.getByTitle('复制发送内容', { exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('发送内容\n中文 ✓');
  await page.locator('.publish-bar').getByRole('button', { name: 'HEX', exact: true }).click();
  await page.getByTitle('复制完整 HEX', { exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(Buffer.from('发送内容\n中文 ✓').toString('hex').match(/../g).join(' ').toUpperCase());

  for (const kind of ['messages', 'logs']) {
    await page.evaluate(() => globalThis.ineedMqtt.db.saveSetting('largeFont', true));
    const opened = app.waitForEvent('window');
    await page.evaluate(kind => globalThis.ineedMqtt.window.openHistory(kind, 'copy-test'), kind);
    const history = await opened;
    await expect(history.locator('.history-row').first()).toBeVisible();
    await expect(history.locator('.history-page')).toHaveClass(/large-font/);
    await page.evaluate(() => globalThis.ineedMqtt.db.saveSetting('largeFont', false));
    await history.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
    await expect(history.locator('.history-page')).not.toHaveClass(/large-font/);
    if (kind === 'messages') await history.locator('.history-row').filter({ hasText: '原始消息' }).click();
    await history.getByRole('button', { name: kind === 'messages' ? '复制完整消息' : '复制内容', exact: true }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain(kind === 'messages' ? '原始消息\n第二行' : '复制测试日志');
  }
});
