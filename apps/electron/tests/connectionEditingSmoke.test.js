import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { _electron as electron, expect } from '@playwright/test';
import { startLocalBroker } from '../../../tooling/mqtt-load-test/localBroker.mjs';

test('native connection editing rejects invalid drafts and preserves an intentional client ID clear after restart', { timeout: 45_000 }, async t => {
  const userData = await mkdtemp(join(tmpdir(), 'mqtt-connection-edit-'));
  const env = { ...process.env, INEED_CLIPBOARD_TEST_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  delete env.INEED_SMOKE_TEST;
  let app;
  let broker;
  t.after(async () => {
    try { await app?.close(); }
    finally {
      try { await broker?.close(); }
      finally { await rm(userData, { recursive: true, force: true }); }
    }
  });
  broker = await startLocalBroker();
  const launch = async () => {
    app = await electron.launch({
      args: [fileURLToPath(new URL('./fixtures/clipboardHarness.cjs', import.meta.url))], env,
      timeout: 15_000,
    });
    return app.firstWindow();
  };
  let page = await launch();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByText('暂无连接', { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await globalThis.ineedMqtt.db.saveSetting('cleanSession', 'false');
    await globalThis.ineedMqtt.db.saveSetting('defaultQos', '2');
  });
  await page.reload();
  await page.getByTitle('新建连接', { exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('Local draft review');
  await page.getByLabel('Client ID', { exact: true }).fill('old-session');
  for (const [field, value, valid] of [
    ['端口', '1883.5', '1883'],
    ['Keep Alive (秒)', '60.5', '60'],
    ['Keep Alive (秒)', '', '60'],
  ]) {
    await page.getByLabel(field, { exact: true }).fill(value);
    await page.getByRole('button', { name: '创建连接', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '新建连接', exact: true })).toBeVisible();
    await expect(page.locator('.modal__err')).toContainText('整数');
    assert.deepEqual(await page.evaluate(() => globalThis.ineedMqtt.db.getConnections()), []);
    await page.getByLabel(field, { exact: true }).fill(valid);
  }
  await page.getByLabel('主机地址', { exact: true }).fill(broker.host);
  await page.getByLabel('端口', { exact: true }).fill(String(broker.port));
  await page.getByLabel('用户名', { exact: true }).fill(broker.username);
  await page.getByLabel('密码', { exact: true }).fill(broker.password);
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const connection = (await page.evaluate(() => globalThis.ineedMqtt.db.getConnections()))[0];
  assert.equal(connection.clean_session, 0);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '断开', exact: true })).toBeVisible();
  await page.getByTitle('添加订阅', { exact: true }).click();
  await expect(page.getByLabel('订阅 QoS', { exact: true })).toHaveValue('2');
  await page.getByLabel('Topic 过滤器', { exact: true }).fill('offline/settings');
  await page.getByRole('button', { name: '确认订阅', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const subscriptions = await page.evaluate(id => globalThis.ineedMqtt.db.getSubscriptions(id), connection.id);
  assert.equal(subscriptions[0].qos, 2);
  await page.getByRole('button', { name: '断开', exact: true }).click();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible();
  await page.locator('.conn-item__edit').click();
  await expect(page.getByLabel('Client ID', { exact: true })).toHaveValue('old-session');
  await page.getByLabel('Client ID', { exact: true }).fill('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal((await page.evaluate(() => globalThis.ineedMqtt.db.getConnections()))[0].client_id, '');
  assert.deepEqual(errors, []);
  await app.close();
  app = null;
  page = await launch();
  await expect(page.locator('.conn-item__edit')).toBeVisible();
  await page.locator('.conn-item__edit').click();
  await expect(page.getByLabel('Client ID', { exact: true })).toHaveValue('');
  assert.equal((await page.evaluate(() => globalThis.ineedMqtt.db.getConnections()))[0].clean_session, 0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
});


test('native WebSocket connection form persists IPv6 and custom paths across restart', { timeout: 45000 }, async t => {
  const { createServer } = await import('node:http'); const { once } = await import('node:events');
  const { WebSocketServer } = await import('ws');
  const userData = await mkdtemp(join(tmpdir(), 'mqtt-ws-edit-'));
  const env = { ...process.env, INEED_CLIPBOARD_TEST_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL; delete env.INEED_SMOKE_TEST;
  const server = createServer(); const ws = new WebSocketServer({ server }); const paths = [];
  let app;
  t.after(async () => {
    await app?.close(); for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve));
    await rm(userData, { recursive: true, force: true });
  });
  ws.on('connection', (socket, req) => {
    paths.push(req.url);
    const require = createRequire(import.meta.url);
    const parser = createRequire(require.resolve('mqtt'))('mqtt-packet').parser();
    parser.on('error', () => socket.terminate());
    parser.on('packet', packet => {
      if (packet.cmd === 'connect') socket.send(Buffer.from([0x20, 2, 0, 0]));
      else if (packet.cmd === 'pingreq') socket.send(Buffer.from([0xd0, 0]));
      else if (packet.cmd === 'disconnect') socket.close();
    });
    socket.on('message', data => parser.parse(data));
  });
  server.listen(0, '::1'); await once(server, 'listening');
  const launch = async () => {
    app = await electron.launch({ args: [fileURLToPath(new URL('./fixtures/clipboardHarness.cjs', import.meta.url))], env, timeout: 15000 });
    return app.firstWindow();
  };
  let page = await launch();
  await page.getByTitle('新建连接', { exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('IPv6 WebSocket');
  await page.getByLabel('协议', { exact: true }).selectOption('ws://');
  await page.getByLabel('主机地址', { exact: true }).fill('::1');
  await page.getByLabel('端口', { exact: true }).fill(String(server.address().port));
  await expect(page.getByLabel('WebSocket 路径', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '创建连接', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '断开', exact: true })).toBeVisible();
  await page.locator('.conn-item__edit').click();
  await page.getByLabel('WebSocket 路径', { exact: true }).fill('/tenant/mqtt?x=1');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '断开', exact: true }).click();
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '断开', exact: true })).toBeVisible();
  assert.deepEqual(paths, ['/mqtt', '/tenant/mqtt?x=1']);
  await app.close(); app = null;
  page = await launch(); await page.locator('.conn-item__edit').click();
  await expect(page.getByLabel('WebSocket 路径', { exact: true })).toHaveValue('/tenant/mqtt?x=1');
  await expect(page.getByLabel('主机地址', { exact: true })).toHaveValue('::1');
});
