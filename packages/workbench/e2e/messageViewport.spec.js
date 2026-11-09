import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

for (const scenario of [
  { theme: 'light', large: false, width: 1440, height: 900 },
  { theme: 'dark', large: false, width: 1120, height: 720 },
  { theme: 'light', large: true, width: 1120, height: 720 },
  { theme: 'dark', large: true, width: 960, height: 600 },
]) {
  test(`virtual messages: ${scenario.theme}, large=${scenario.large}, width=${scenario.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario);
    await page.addInitScript(installPreviewAdapter);
    await page.addInitScript(() => {
      globalThis.__viewportErrors = [];
      globalThis.addEventListener('error', event => globalThis.__viewportErrors.push(String(event.message)));
      const adapter = globalThis.__INEED_VISUAL_ADAPTER__;
      const subscribe = adapter.mqtt.onMessages;
      adapter.mqtt.onMessages = handler => { globalThis.__receiveVirtualMessages = handler; return subscribe(handler); };
      adapter.clipboard.writeText = async text => { globalThis.__virtualCopied = text; };
    });
    await page.goto(`/?visualRuntime=${testInfo.project.metadata.runtime || 'electron'}`);
    await expect(page.locator('.chat-msg').first()).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByLabel('主题', { exact: true }).selectOption(scenario.theme);
    if (scenario.large) await settings.getByRole('switch', { name: '大字模式' }).click();
    await settings.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByLabel('搜索 Topic（收发均生效）', { exact: true }).fill('virtual/');
    await page.evaluate(() => globalThis.__receiveVirtualMessages(Array.from({ length: 300 }, (_, index) => ({
      connId: 'connection-1', topic: `virtual/${String(index).padStart(4, '0')}`,
      payload: `payload ${index}\n` + (index % 7 === 0 ? 'long line\n'.repeat(80) : 'short'),
      qos: 1, retained: false, timestamp: Date.now(), historyPersisted: true,
    }))));
    const stream = page.locator('.msg-chat');
    await expect(page.locator('.chat-msg__topic').last()).toHaveText('virtual/0299');
    expect(await page.locator('.chat-msg').count()).toBeLessThan(30);
    await expect(page.getByRole('button', { name: '跟随最新' })).toHaveAttribute('aria-pressed', 'true');
    await stream.dispatchEvent('wheel', { deltaY: -100 });
    await stream.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect(page.locator('.chat-msg__topic').first()).toHaveText('virtual/0000');
    const first = page.locator('.chat-msg').first();
    await first.getByRole('button', { name: '复制消息', exact: true }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__virtualCopied)).toContain('payload 0');
    await first.locator('.chat-msg__bubble').click();
    await expect(page.locator('.message-inspector')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '折叠连接列表' }).click();
    await page.getByRole('button', { name: '展开连接列表' }).click();
    // While reading older messages, retention trims the head as new rows arrive.
    // The surviving visible row must keep its position instead of jumping.
    await stream.evaluate(el => { el.scrollTop = el.scrollHeight / 2; el.dispatchEvent(new Event('scroll')); });
    await expect(page.getByRole('button', { name: '已暂停跟随' })).toHaveAttribute('aria-pressed', 'false');
    const readAnchor = () => stream.evaluate(el => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll('.chat-msg')].find(row => row.getBoundingClientRect().bottom > top);
      return { topic: row.querySelector('.chat-msg__topic').textContent, top: row.getBoundingClientRect().top - top };
    });
    let anchor;
    await expect.poll(async () => {
      anchor = await readAnchor();
      return Number(anchor.topic.split('/')[1]);
    }).toBeGreaterThan(100);
    let previousAnchor = null;
    await expect.poll(async () => {
      anchor = await readAnchor();
      const stable = previousAnchor && anchor.topic === previousAnchor.topic && Math.abs(anchor.top - previousAnchor.top) < 0.5;
      previousAnchor = anchor;
      return stable;
    }, { intervals: [100, 100, 100] }).toBe(true);
    await page.evaluate(() => globalThis.__receiveVirtualMessages(Array.from({ length: 100 }, (_, index) => ({
      connId: 'connection-1', topic: `virtual/${String(index + 300).padStart(4, '0')}`,
      payload: `payload ${index + 300}`, qos: 1, retained: false, timestamp: Date.now(), historyPersisted: true,
    }))));
    await expect.poll(async () => (await readAnchor()).topic).toBe(anchor.topic);
    await expect.poll(async () => Math.abs((await readAnchor()).top - anchor.top)).toBeLessThan(2);
    await page.getByRole('button', { name: '已暂停跟随' }).click();
    await expect(page.locator('.chat-msg__topic').last()).toHaveText('virtual/0399');
    await expect(page.getByRole('button', { name: '跟随最新' })).toHaveAttribute('aria-pressed', 'true');
    // Filtering still operates on all retained records, including unrendered ones.
    await page.getByLabel('搜索 Topic（收发均生效）', { exact: true }).fill('virtual/0123');
    await expect(page.locator('.chat-msg')).toHaveCount(1);
    await expect(page.locator('.chat-msg__topic')).toHaveText('virtual/0123');
    expect(await page.evaluate(() => globalThis.__viewportErrors)).toEqual([]);
  });
}
