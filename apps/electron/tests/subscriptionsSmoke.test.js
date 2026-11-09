import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { _electron as electron, expect } from '@playwright/test';
import mqtt from 'mqtt';
import { startLocalBroker } from '../../../tooling/mqtt-load-test/localBroker.mjs';

test('native subscriptions survive covering-filter removal and offline cleanup survives restart', { timeout: 45_000 }, async t => {
  const userData = await mkdtemp(join(tmpdir(), 'mqtt-subscriptions-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const broker = await startLocalBroker();
  t.after(() => broker.close());
  const publisher = await mqtt.connectAsync(`mqtt://${broker.host}:${broker.port}`, {
    username: broker.username, password: broker.password, clientId: 'subscription-review-publisher',
  });
  t.after(() => publisher.endAsync(true));
  const env = { ...process.env, INEED_CLIPBOARD_TEST_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  delete env.INEED_SMOKE_TEST;
  let app;
  t.after(async () => { await app?.close(); });
  async function launch() {
    app = await electron.launch({
      args: [fileURLToPath(new URL('./fixtures/clipboardHarness.cjs', import.meta.url))], env,
      timeout: 15_000,
    });
    return app.firstWindow();
  }
  async function add(page, topic) {
    await page.getByTitle('添加订阅', { exact: true }).click();
    await page.getByLabel('Topic 过滤器', { exact: true }).fill(topic);
    await page.getByRole('button', { name: '确认订阅', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '添加订阅', exact: true })).toHaveCount(0);
  }
  async function remove(page, topic) {
    await page.getByRole('button', { name: `更多订阅操作 ${topic}`, exact: true }).click();
    await page.getByRole('menuitem', { name: '取消订阅…', exact: true }).click();
    await page.getByRole('button', { name: '确认取消', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '取消订阅', exact: true })).toHaveCount(0);
  }
  let page = await launch();
  await expect(page.getByText('暂无连接', { exact: true })).toBeVisible();
  await page.evaluate(async connection => {
    await globalThis.ineedMqtt.db.saveConnection(connection);
  }, {
    id: 'review-connection', name: 'Subscription Review', protocol: 'mqtt', host: broker.host,
    port: broker.port, username: broker.username, password: broker.password,
    client_id: 'subscription-review-persistent', clean_session: 0,
  });
  await page.reload();
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '断开', exact: true })).toBeVisible();
  await add(page, 'review/#');
  await add(page, 'review/value');
  await publisher.publishAsync('review/value', 'before-removal', { qos: 1 });
  await expect(page.locator('.chat-msg--in').filter({ hasText: 'before-removal' })).toHaveCount(1);
  await remove(page, 'review/#');
  await publisher.publishAsync('review/value', 'after-removal', { qos: 1 });
  await expect(page.locator('.chat-msg--in').filter({ hasText: 'after-removal' })).toHaveCount(1);

  await page.getByRole('button', { name: '断开', exact: true }).click();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible();
  await remove(page, 'review/value');
  assert.deepEqual(await page.evaluate(() => globalThis.ineedMqtt.db.getSubscriptions('review-connection')), []);
  await app.close();
  app = null;
  page = await launch();
  await expect(page.locator('.subscription-panel__connection')).toHaveText('Subscription Review');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '断开', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (
    await globalThis.ineedMqtt.db.getAllSettings()
  )['mqtt.pendingUnsubscriptions.review-connection'])).toBe('[]');
  await add(page, 'sentinel/value');
  // Both publishes use the same socket and QoS; receiving the later sentinel
  // demonstrates that the broker and renderer have processed the earlier one.
  await publisher.publishAsync('review/value', 'deleted-session-filter', { qos: 1 });
  await publisher.publishAsync('sentinel/value', 'cleanup-sentinel', { qos: 1 });
  await expect(page.locator('.chat-msg--in').filter({ hasText: 'cleanup-sentinel' })).toHaveCount(1);
  await expect(page.locator('.chat-msg--in').filter({ hasText: 'deleted-session-filter' })).toHaveCount(0);
});
