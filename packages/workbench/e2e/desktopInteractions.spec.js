import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

test('desktop preferences, original copy, paused reception and modal keyboard behavior', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(installPreviewAdapter);
  await page.addInitScript(() => {
    const adapter = globalThis.__INEED_VISUAL_ADAPTER__;
    adapter.clipboard.writeText = text => navigator.clipboard.writeText(text);
    const subscribe = adapter.mqtt.onMessages;
    adapter.mqtt.onMessages = handler => {
      globalThis.__desktopReceive = handler;
      return subscribe(handler);
    };
  });
  await page.goto('/?visualRuntime=electron');
  await expect(page.locator('.chat-msg').first()).toBeVisible();
  await page.getByTitle('切换显示密度').click();
  await expect(page.locator('.mqtt-app')).toHaveAttribute('data-density', 'compact');
  await page.getByRole('separator', { name: '调整资源栏宽度' }).press('ArrowRight');
  await page.reload();
  await expect(page.locator('.mqtt-app')).toHaveAttribute('data-density', 'compact');
  await expect(page.getByRole('separator', { name: '调整资源栏宽度' })).toHaveAttribute('aria-valuenow', '250');

  const stream = page.locator('.msg-chat');
  await stream.dispatchEvent('wheel', { deltaY: -100 });
  await expect(page.getByRole('button', { name: '已暂停跟随' })).toBeVisible();
  await page.evaluate(() => globalThis.__desktopReceive([{
    connId: 'connection-1', topic: 'sensors/original', payload: ' { "温度": 23 }\n',
    qos: 1, retained: false, timestamp: Date.now(),
  }]));
  await page.getByRole('button', { name: /1 条新记录/ }).click();
  await expect(page.getByRole('button', { name: '跟随最新' })).toBeVisible();
  await page.locator('.chat-msg').last().locator('.chat-msg__bubble').click();
  await page.getByRole('button', { name: '复制原始文本' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(' { "温度": 23 }\n');
  await page.keyboard.press('Escape');
  await expect(page.locator('.message-inspector')).toHaveCount(0);

  await page.getByText('设置', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByLabel('主题', { exact: true }).selectOption('dark');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '放弃修改' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByText('设置', { exact: true }).click();
  await dialog.getByLabel('主题', { exact: true }).selectOption('dark');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.mqtt-app')).toHaveAttribute('data-theme', 'dark');
  await page.getByTitle('新建连接').click();
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Boolean(globalThis.document.activeElement.closest('[role="dialog"]')))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTitle('新建连接')).toBeFocused();
});
