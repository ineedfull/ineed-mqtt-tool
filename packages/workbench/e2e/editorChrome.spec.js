import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

for (const scenario of [
  { name: 'light', theme: 'light', large: false },
  { name: 'dark', theme: 'dark', large: false },
  { name: 'dark-large', theme: 'dark', large: true },
]) {
  test(`${scenario.name}: JSON search controls follow the workbench theme`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 600 });
    await page.addInitScript(installPreviewAdapter);
    await page.goto('/');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByLabel('主题', { exact: true }).selectOption(scenario.theme);
    if (scenario.large) await settings.getByRole('switch', { name: '大字模式' }).click();
    await settings.getByRole('button', { name: '保存', exact: true }).click();

    const editor = page.locator('.payload-editor');
    await editor.locator('.cm-content').fill('{"command":"toggle"}');
    await editor.locator('.cm-content').click();
    await page.keyboard.press('Meta+f');
    const panel = editor.locator('.cm-panel.cm-search');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('textbox', { name: '查找' })).toBeVisible();
    await expect(panel.getByRole('button', { name: '下一个' })).toBeVisible();
    expect(await editor.locator('.cm-scroller').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(64);
    await page.screenshot({ path: testInfo.outputPath('editor-search.png') });
    const colors = await panel.evaluate(element => {
      const input = element.querySelector('.cm-textfield');
      const channels = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
      return {
        panel: channels(globalThis.getComputedStyle(element).backgroundColor),
        input: channels(globalThis.getComputedStyle(input).backgroundColor),
        text: channels(globalThis.getComputedStyle(input).color),
      };
    });
    if (scenario.theme === 'dark') {
      expect(Math.max(...colors.panel)).toBeLessThan(100);
      expect(Math.max(...colors.input)).toBeLessThan(100);
      expect(Math.min(...colors.text)).toBeGreaterThan(150);
    }
    const overflow = await panel.evaluate(element => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await panel.getByRole('button', { name: '关闭' }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.publish-bar')).toHaveCSS('height', '220px');
  });
}
