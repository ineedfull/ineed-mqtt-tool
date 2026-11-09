import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

test('About is a keyboard-accessible dialog that preserves the current debug context', async ({ page }) => {
  await page.addInitScript(installPreviewAdapter);
  await page.goto('/');
  await page.getByPlaceholder('输入目标 Topic...').fill('debug/keep-this-topic');
  await page.getByRole('tab', { name: '日志', exact: true }).click();
  const trigger = page.getByRole('button', { name: '关于', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '关于', exact: true });
  await expect(dialog).toContainText('Ineed MQTT Tool');
  await expect(dialog).toContainText('开发与调试小助手');
  await expect(dialog.locator('.about-panel__runtime')).toHaveText('Electron');
  await expect(dialog.getByRole('button', { name: '检查更新' })).toBeVisible();
  const close = dialog.getByRole('button', { name: '关闭关于' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  // Explicit tab stops also keep WebKit's default keyboard mode inside About.
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
    }
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('tab', { name: '日志', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByPlaceholder('输入目标 Topic...')).toHaveValue('debug/keep-this-topic');
  await trigger.click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(trigger).toBeFocused();
});
