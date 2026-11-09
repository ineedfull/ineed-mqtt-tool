import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

for (const scenario of [
  { name: 'dark', width: 1440, height: 900, theme: 'dark', large: false },
  { name: 'light-large', width: 960, height: 600, theme: 'light', large: true },
  { name: 'narrow-collapsed', width: 800, height: 600, theme: 'light', large: false, collapsed: true },
]) {
  test(`${scenario.name}: JSON fold control aligns before line numbers`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript(installPreviewAdapter);
    await page.goto('/');

    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByLabel('主题', { exact: true }).selectOption(scenario.theme);
    if (scenario.large) await settings.getByRole('switch', { name: '大字模式' }).click();
    await settings.getByRole('button', { name: '保存', exact: true }).click();
    if (scenario.collapsed) {
      await page.getByRole('button', { name: '折叠连接列表', exact: true }).click();
    }

    const editor = page.locator('.payload-editor');
    await editor.locator('.cm-content').fill('{\n  "command": "toggle",\n  "state": "on"\n}');
    const marker = editor.locator('.cm-foldGutter .payload-fold-marker--open');
    await expect(marker).toBeVisible();
    const geometry = await editor.evaluate(root => {
      const fold = root.querySelector('.cm-foldGutter').getBoundingClientRect();
      const numbers = root.querySelector('.cm-lineNumbers').getBoundingClientRect();
      const markerElement = root.querySelector('.cm-foldGutter .payload-fold-marker--open');
      const marker = markerElement.getBoundingClientRect();
      const icon = globalThis.getComputedStyle(markerElement, '::before');
      const line = [...root.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
        .find(element => element.textContent.trim() === '1' && globalThis.getComputedStyle(element).visibility !== 'hidden')
        .getBoundingClientRect();
      return {
        foldRight: fold.right,
        numbersLeft: numbers.left,
        foldWidth: fold.width,
        foldMiddle: (fold.left + fold.right) / 2,
        markerHorizontalMiddle: (marker.left + marker.right) / 2,
        markerMiddle: (marker.top + marker.bottom) / 2,
        lineMiddle: (line.top + line.bottom) / 2,
        markerWidth: marker.width,
        markerHeight: marker.height,
        iconWidth: Number.parseFloat(icon.width),
        iconStroke: Number.parseFloat(icon.borderRightWidth),
      };
    });
    expect(geometry.foldRight).toBeLessThanOrEqual(geometry.numbersLeft + 1);
    expect(geometry.foldWidth).toBe(20);
    expect(Math.abs(geometry.markerHorizontalMiddle - geometry.foldMiddle)).toBeLessThan(2);
    expect(Math.abs(geometry.markerMiddle - geometry.lineMiddle)).toBeLessThan(2);
    expect(geometry.markerWidth).toBe(20);
    expect(geometry.markerHeight).toBe(20);
    expect(geometry.iconWidth).toBe(8);
    expect(geometry.iconStroke).toBe(2);
    await page.screenshot({ path: testInfo.outputPath('fold-gutter.png') });

    await marker.click();
    const placeholder = editor.locator('.cm-foldPlaceholder');
    await expect(placeholder).toBeVisible();
    if (scenario.theme === 'dark') {
      const background = await placeholder.evaluate(element => globalThis.getComputedStyle(element).backgroundColor);
      const channels = background.match(/[\d.]+/g).slice(0, 3).map(Number);
      expect(Math.max(...channels)).toBeLessThan(100);
    }
    await page.screenshot({ path: testInfo.outputPath('folded-gutter.png') });
    const closedMarker = editor.locator('.cm-foldGutter .payload-fold-marker--closed:visible');
    await expect(closedMarker).toBeVisible();
    await closedMarker.click();
    await expect(editor.locator('.cm-foldPlaceholder')).toHaveCount(0);
  });
}
