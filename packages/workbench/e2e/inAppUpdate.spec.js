import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

function installUpdateFixture() {
  const adapter = globalThis.__INEED_VISUAL_ADAPTER__;
  let listener = () => {};
  let state = { phase: 'available', supported: true, version: '0.1.1' };
  const change = patch => { state = { ...state, ...patch }; listener(state); };
  adapter.update = {
    getState: async () => state,
    onState: handler => { listener = handler; return () => {}; },
    check: async () => ({ available: true, automatic: true, version: '0.1.1', description: '隔离 UI 测试' }),
    download: async () => change({ phase: 'downloading', transferred: 524288, total: 1048576, canCancel: true }),
    cancel: async () => change({ phase: 'available' }),
    install: async () => change({ phase: 'ready', error: '隔离测试：数据保存失败，安装已停止。' }),
  };
  globalThis.__UPDATE_FIXTURE_CHANGE__ = change;
}

for (const scenario of [
  { name: 'light', width: 1120, height: 720, theme: 'light', large: false },
  { name: 'dark', width: 1120, height: 720, theme: 'dark', large: false },
  { name: 'light-large', width: 960, height: 600, theme: 'light', large: true },
  { name: 'dark-large', width: 960, height: 600, theme: 'dark', large: true },
  { name: 'narrow-collapsed', width: 800, height: 600, theme: 'light', large: false, collapsed: true },
]) {
  test(`${scenario.name}: download, cancel, verification and confirmed restart remain usable`, async ({ page }, testInfo) => {
    const runtime = testInfo.project.metadata.runtime;
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript({ content: `(${installPreviewAdapter.toString()})(); (${installUpdateFixture.toString()})();` });
    await page.goto(`/?visualRuntime=${runtime}&theme=${scenario.theme}&large=${scenario.large}`);
    await page.evaluate(() => {
      const style = globalThis.document.querySelector('style[data-visual-fixture]');
      style.textContent = style.textContent.replace(/^.*font-family.*$/gm, '');
    });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByLabel('主题', { exact: true }).selectOption(scenario.theme);
    if (scenario.large) await settings.getByRole('switch', { name: '大字模式' }).click();
    await settings.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.mqtt-app')).toHaveAttribute('data-theme', scenario.theme);
    if (scenario.large) await expect(page.locator('.mqtt-app')).toHaveClass(/large-font/);
    if (scenario.collapsed) await page.getByRole('button', { name: '折叠连接列表', exact: true }).click();
    await page.getByRole('button', { name: '关于', exact: true }).click();
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: '更新下载进度' })).toHaveAttribute('value', '524288');
    await page.getByRole('button', { name: '取消下载', exact: true }).click();
    await page.getByRole('button', { name: '下载更新', exact: true }).click();
    await page.evaluate(() => globalThis.__UPDATE_FIXTURE_CHANGE__({ phase: 'verifying' }));
    await expect(page.getByText('正在校验更新', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重启并安装', exact: true })).toHaveCount(0);
    await page.evaluate(() => globalThis.__UPDATE_FIXTURE_CHANGE__({ phase: 'ready' }));
    await page.getByRole('button', { name: '关闭关于', exact: true }).click();
    await page.getByRole('button', { name: '关于', exact: true }).click();
    await page.getByRole('button', { name: '重启并安装', exact: true }).click();
    await expect(page.getByRole('group', { name: '确认安装更新' })).toBeVisible();
    await page.getByRole('button', { name: '确认重启并安装', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '安装已停止' })).toBeVisible();
    const overflow = await page.locator('.about-panel').evaluate(node => node.scrollWidth > node.clientWidth + 1);
    expect(overflow).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('update-ready-error.png') });
  });
}
