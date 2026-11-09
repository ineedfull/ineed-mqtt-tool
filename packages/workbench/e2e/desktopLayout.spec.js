import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

for (const scenario of [
  { name: 'standard', viewport: { width: 1120, height: 720 }, theme: 'light', large: false },
  { name: 'small-large-font', viewport: { width: 960, height: 600 }, theme: 'light', large: true },
  { name: 'dark', viewport: { width: 1440, height: 900 }, theme: 'dark', large: false },
]) {
  test(`${scenario.name}: settings contain scrolling and the collapsed rail matches DevTool`, async ({ page }, testInfo) => {
    await page.setViewportSize(scenario.viewport);
    await page.addInitScript(installPreviewAdapter);
    await page.addInitScript(() => {
      const adapter = globalThis.__INEED_VISUAL_ADAPTER__;
      const list = adapter.connection.list;
      adapter.connection.list = async () => {
        const connections = await list();
        return [...connections, ...Array.from({ length: 18 }, (_, index) => ({
          ...connections[0], id: `extra-${index}`, name: `测试连接 ${index + 1}`,
        }))];
      };
    });
    await page.goto('/');
    // Keep fixture timing deterministic while measuring the actual application fonts.
    await page.evaluate(() => {
      const style = globalThis.document.querySelector('style[data-visual-fixture]');
      style.textContent = style.textContent.replace(/^.*font-family.*$/gm, '');
    });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置', exact: true });
    await dialog.getByLabel('主题', { exact: true }).selectOption(scenario.theme);
    if (scenario.large) await dialog.getByRole('switch', { name: '大字模式' }).click();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await dialog.evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished));
    });
    const before = await layout(dialog);
    await dialog.locator('.settings-area').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const after = await layout(dialog);
    expect(after.scrollTop).toBeGreaterThan(0);
    expect(after.dialogScroll).toBe(0);
    expect(after.footerTop).toBeCloseTo(before.footerTop, 0);
    expect(after.headerTop).toBeCloseTo(before.headerTop, 0);
    assertLayout(after, scenario.viewport.height);
    await expect(dialog.getByRole('button', { name: '清空历史数据' })).toBeInViewport();
    await dialog.getByRole('button', { name: '清空历史数据' }).click({ trial: true });
    await page.screenshot({ path: testInfo.outputPath('settings-bottom.png') });
    await dialog.getByRole('switch', { name: '自动重连', exact: true }).click();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '继续编辑' })).toBeVisible();
    assertLayout(await layout(dialog), scenario.viewport.height);
    await dialog.getByRole('button', { name: '放弃修改' }).click();
    await page.screenshot({ path: testInfo.outputPath('expanded-sidebar.png') });
    await page.getByRole('button', { name: '折叠连接列表', exact: true }).click();
    const rail = page.locator('.left-panel');
    await expect(rail.getByAltText('Ineed MQTT Tool')).toBeVisible();
    for (const name of ['展开连接列表', '设置', '关于']) await expect(rail.getByRole('button', { name, exact: true })).toBeVisible();
    const measurements = await rail.evaluate(element => {
      const box = selector => element.querySelector(selector).getBoundingClientRect();
      const list = element.querySelector('.conn-list');
      return { width: element.getBoundingClientRect().width, tileWidth: box('.conn-item').width,
        tileHeight: box('.conn-item').height, gap: box('.conn-item:nth-child(2)').top - box('.conn-item').bottom,
        footer: box('.left-bottom').height, scrolling: list.scrollHeight > list.clientHeight,
        noOverflow: element.scrollWidth <= element.clientWidth };
    });
    expect(measurements).toEqual({ width: 58, tileWidth: 40, tileHeight: 40, gap: 6, footer: 78, scrolling: true, noOverflow: true });
    await expect(rail.locator('.conn-item__initial').first()).toHaveText('LL');
    await rail.getByRole('button', { name: '选择连接 Staging Broker', exact: true }).click();
    await expect(rail.getByRole('button', { name: '选择连接 Staging Broker', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: testInfo.outputPath('collapsed-sidebar.png') });
    await rail.getByRole('button', { name: '关于', exact: true }).click();
    await page.getByRole('dialog', { name: '关于', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    await rail.getByRole('button', { name: '选择连接 Local Lab', exact: true }).click();
    await expect(page.getByRole('tab', { name: '消息', exact: true })).toHaveAttribute('aria-selected', 'true');
    await rail.getByRole('button', { name: '展开连接列表' }).click();
    await expect(rail.getByRole('searchbox', { name: '查找连接' })).toBeVisible();
  });
}
async function layout(dialog) {
  return dialog.evaluate(element => {
    const rect = node => node.getBoundingClientRect();
    const body = element.querySelector('.settings-area'), header = element.querySelector('header');
    const footer = element.querySelector('footer'), notice = element.querySelector('.settings-discard');
    return { headerTop: rect(header).top, headerBottom: rect(header).bottom, bodyTop: rect(body).top,
      bodyBottom: rect(body).bottom, footerTop: rect(footer).top, footerBottom: rect(footer).bottom,
      noticeTop: notice ? rect(notice).top : null, scrollTop: body.scrollTop, dialogScroll: element.scrollTop,
      dialogContent: element.scrollHeight, dialogClient: element.clientHeight };
  });
}
function assertLayout(value, height) {
  expect(value.headerTop).toBeGreaterThanOrEqual(0);
  expect(value.bodyTop).toBeGreaterThanOrEqual(value.headerBottom - 1);
  expect(value.bodyBottom).toBeLessThanOrEqual((value.noticeTop ?? value.footerTop) + 1);
  expect(value.footerBottom).toBeLessThanOrEqual(height);
  expect(value.dialogContent).toBeLessThanOrEqual(value.dialogClient + 1);
}
