import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

test('settings keep every Tab stop inside, skip disabled save, and restore their trigger', async ({ page }) => {
  await page.addInitScript(installPreviewAdapter);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '设置', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog.getByRole('button', { name: '关闭设置' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let index = 0; index < 70; index += 1) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
    }
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole('button', { name: '关闭设置' }).click();
  await expect(trigger).toBeFocused();
});
