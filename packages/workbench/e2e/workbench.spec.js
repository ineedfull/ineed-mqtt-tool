import { expect, test } from '@playwright/test';

import { installPreviewAdapter } from './fixtures/previewAdapter.js';

function captureBrowserErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/favicon.ico', route => route.fulfill({
    body: '',
    contentType: 'image/x-icon',
    status: 200,
  }));
  await page.addInitScript(installPreviewAdapter);
});

test('renders the primary workbench workflow with the preview adapter', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page);

  await page.goto('/');

  await expect(page.locator('.conn-item__name').filter({ hasText: /^Local Lab$/ })).toBeVisible();
  await expect(page.getByText('Staging Broker', { exact: true })).toBeVisible();
  await expect(page.locator('.sub-item__topic').filter({ hasText: /^sensors\/#$/ })).toBeVisible();
  await page.getByRole('button', { name: '选择连接 Staging Broker', exact: true }).click();
  await expect(page.locator('.sub-item__topic').filter({ hasText: 'devices/+/status' })).toBeVisible();
  await page.getByRole('button', { name: '选择连接 Local Lab', exact: true }).click();

  await expect(page.getByRole('tab', { name: '消息', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '日志', exact: true }).click();
  await expect(page.getByText('暂无日志', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '消息', exact: true }).click();

  await expect(page.getByTitle('添加订阅')).toBeVisible();
  const subscriptionActions = page.getByTitle('更多订阅操作').first();
  await subscriptionActions.click();
  await expect(page.getByRole('menuitem', { name: '取消订阅…', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(subscriptionActions).toBeFocused();
  await expect(page.getByPlaceholder('输入目标 Topic...')).toBeVisible();
  await expect(page.locator('.publish-bar .cm-editor')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();

  await page.getByText('设置', { exact: true }).click();
  await page.getByText('数据存储', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByText('数据存储', { exact: true })).toBeVisible();
  await expect(page.getByText('12 KB', { exact: true })).toBeVisible();

  expect(browserErrors).toEqual([]);
  expect(browserErrors.join('\n')).not.toContain('runtime adapter was not provided');
});

test('renders an empty message history without runtime adapter errors', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page);

  await page.goto('/?history=messages');

  await expect(page.getByRole('heading', { name: '历史消息' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Local Lab' })).toHaveCount(1);
  await expect(page.getByRole('option', { name: 'Staging Broker' })).toHaveCount(1);
  await expect(page.getByPlaceholder('搜索内容')).toBeVisible();
  await expect(page.getByPlaceholder('Topic')).toBeVisible();
  await expect(page.getByText('暂无历史记录', { exact: true })).toBeVisible();
  await expect(page.getByText('共 0 条', { exact: true })).toBeVisible();

  expect(browserErrors).toEqual([]);
  expect(browserErrors.join('\n')).not.toContain('runtime adapter was not provided');
});
