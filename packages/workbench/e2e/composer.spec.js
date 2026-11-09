import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

function capturePublish() {
  const adapter = globalThis.__INEED_VISUAL_ADAPTER__;
  globalThis.__publishes = [];
  adapter.clipboard.writeText = async text => { globalThis.__copiedText = text; };
  adapter.mqtt.publish = async (...args) => {
    globalThis.__publishes.push(args);
    return { ok: true };
  };
}

for (const scenario of [
  { width: 1440, height: 900, theme: 'light', large: false },
  { width: 1120, height: 720, theme: 'dark', large: false },
  { width: 960, height: 600, theme: 'light', large: true },
]) {
  test(`${scenario.width}: composer edits, copies, publishes and schedules without clipped controls`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario);
    await page.addInitScript({ content: `(${installPreviewAdapter.toString()})(); (${capturePublish.toString()})();` });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/?visualRuntime=${testInfo.project.metadata.runtime}`);
    await page.evaluate(() => {
      const style = globalThis.document.querySelector('style[data-visual-fixture]');
      style.textContent = style.textContent.replace(/^.*font-family.*$/gm, '');
    });
    if (scenario.large || scenario.theme === 'dark') {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      await settings.getByLabel('主题', { exact: true }).selectOption(scenario.theme);
      if (scenario.large) await settings.getByRole('switch', { name: '大字模式' }).click();
      await settings.getByRole('button', { name: '保存', exact: true }).click();
    }
    const composer = page.locator('.publish-bar');
    const editor = composer.locator('.cm-content');
    const send = composer.getByRole('button', { name: '发送', exact: true });
    await page.getByLabel('主题', { exact: true }).fill('commands/test');
    await editor.fill('{"value":42,"name":"测试"}');
    await composer.getByRole('button', { name: '格式化', exact: true }).click();
    await composer.getByTitle('复制发送内容', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(globalThis.__copiedText))).toEqual({ value: 42, name: '测试' });
    await send.click();
    await expect.poll(() => page.evaluate(() => globalThis.__publishes.length)).toBe(1);
    await assertFits(composer);
    await page.screenshot({ path: testInfo.outputPath('composer.png') });
    await editor.fill('{invalid');
    await expect(send).toBeDisabled();
    await expect(composer.locator('.publish-footer__status')).toContainText('JSON 无效');
    await expect(composer.locator('.cm-lint-marker-error')).toBeVisible();
    await composer.getByRole('button', { name: 'Text', exact: true }).click();
    await editor.fill('中文');
    await composer.getByRole('button', { name: 'HEX', exact: true }).click();
    await expect(composer.locator('.publish-bar__hex-preview')).toHaveText('E4 B8 AD E6 96 87');
    await composer.getByTitle('复制完整 HEX', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__copiedText)).toBe('E4 B8 AD E6 96 87');
    await editor.press('Control+Enter');
    await expect.poll(() => page.evaluate(() => globalThis.__publishes.length)).toBe(2);
    await composer.getByRole('button', { name: '定时发送', exact: true }).click();
    await composer.getByLabel('定时发送间隔（秒）').fill('1');
    await composer.getByRole('button', { name: '▶ 开始', exact: true }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__publishes.length)).toBeGreaterThan(2);
    await assertFits(composer);
    await page.screenshot({ path: testInfo.outputPath('composer-timer-hex.png') });
    await composer.getByRole('button', { name: '停止', exact: true }).click();
    await expect(composer.getByRole('button', { name: '▶ 开始', exact: true })).toBeVisible();
    await composer.getByRole('button', { name: '定时发送', exact: true }).click();
    await page.getByRole('button', { name: '断开', exact: true }).click();
    await expect(composer.locator('.publish-footer__hint')).toHaveText('请先连接 Broker');
    await expect(send).toBeDisabled();
    await assertFits(composer);
    await page.screenshot({ path: testInfo.outputPath('composer-disconnected.png') });
    expect(errors).toEqual([]);
  });
}

async function assertFits(composer) {
  const clipped = await composer.evaluate(root => {
    const bounds = root.getBoundingClientRect();
    return [...root.querySelectorAll('button, input, select, .payload-editor, .publish-footer__hint')]
      .filter(element => element.getBoundingClientRect().width > 0)
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.left < bounds.left || rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1 || rect.top < bounds.top;
      }).map(element => element.textContent || element.getAttribute('aria-label'));
  });
  expect(clipped).toEqual([]);
}

test('saved composer height survives reopening', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript({ content: `(${installPreviewAdapter.toString()})();` });
  await page.goto(`/?visualRuntime=${testInfo.project.metadata.runtime}`);
  const divider = page.getByRole('separator', { name: '调整发送区高度' });
  await divider.press('ArrowUp');
  await expect(divider).toHaveAttribute('aria-valuenow', '240');
  await page.reload();
  await expect(divider).toHaveAttribute('aria-valuenow', '240');
  await expect(page.locator('.publish-bar')).toHaveCSS('height', '240px');
});
