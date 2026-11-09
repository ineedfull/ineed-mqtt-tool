import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

function installClipboard() {
  globalThis.__INEED_VISUAL_ADAPTER__.clipboard.writeText = async text => { globalThis.__copiedText = text; };
}

for (const scenario of [
  { width: 1440, height: 900, theme: 'light', large: false },
  { width: 1120, height: 720, theme: 'dark', large: false },
  { width: 960, height: 600, theme: 'light', large: true },
]) {
  test(`${scenario.width}: subscriptions stay usable beside collapsed connections and messages use chat bubbles`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript({ content: `(${installPreviewAdapter.toString()})(); (${installClipboard.toString()})();` });
    await page.goto(`/?visualRuntime=${testInfo.project.metadata.runtime || 'electron'}`);
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
    const subscriptions = page.getByRole('complementary', { name: '当前连接的订阅' });
    await expect(subscriptions).toBeVisible();
    const sensorRow = subscriptions.locator('.sub-item').filter({ hasText: 'sensors/#' });
    const alertRow = subscriptions.locator('.sub-item').filter({ hasText: 'alerts/+' });
    // A subscription looks like one clickable row, including metadata and padding.
    for (const target of ['.sub-item__topic', '.sub-item__fmt', '.sub-item__qos', '.sub-item__color', null]) {
      for (const [row, count] of [[sensorRow, 2], [alertRow, 1]]) {
        if (target) await row.locator(target).click();
        else await row.click({ position: { x: 3, y: 3 } });
        await expect(row.locator('.sub-item__select')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.chat-msg')).toHaveCount(count);
      }
    }
    await sensorRow.getByTitle('复制订阅主题').click();
    await expect(alertRow.locator('.sub-item__select')).toHaveAttribute('aria-pressed', 'true');
    await sensorRow.getByTitle('更多订阅操作').click();
    await expect(alertRow.locator('.sub-item__select')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await sensorRow.getByTitle('更多订阅操作').click();
    // The menu overlays the next row's right side; click its exposed left edge.
    await alertRow.locator('.sub-item__color').click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('.chat-msg')).toHaveCount(3);
    await sensorRow.locator('.sub-item__select').press('Space');
    await expect(page.locator('.chat-msg')).toHaveCount(2);
    await sensorRow.locator('.sub-item__select').press('Enter');
    await expect(page.locator('.chat-msg')).toHaveCount(3);
    await expect(page.locator('.message-columns')).toHaveCount(0);
    await assertColumns(page);
    await page.screenshot({ path: testInfo.outputPath('expanded-chat.png') });
    await page.getByRole('button', { name: '折叠连接列表' }).click();
    await assertColumns(page);
    await expect(subscriptions.locator('.subscription-panel__connection')).toHaveText('Local Lab');
    await subscriptions.getByRole('button', { name: '筛选订阅 sensors/#', exact: true }).click();
    await expect(page.locator('.chat-msg')).toHaveCount(2);
    await page.getByTitle('取消订阅过滤').click();
    await expect(page.locator('.chat-msg')).toHaveCount(3);
    await subscriptions.getByTitle('复制订阅主题').first().click();
    await expect.poll(() => page.evaluate(() => globalThis.__copiedText)).toBe('sensors/#');
    await subscriptions.getByTitle('更多订阅操作').first().click();
    await page.getByRole('menuitem', { name: '复制到连接…', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '复制订阅', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await subscriptions.getByTitle('添加订阅').click();
    const add = page.getByRole('dialog', { name: '添加订阅', exact: true });
    await add.getByLabel('Topic 过滤器', { exact: true }).fill('test/independent/#');
    await add.getByRole('button', { name: '确认订阅', exact: true }).click();
    const added = subscriptions.locator('.sub-item').filter({ hasText: 'test/independent/#' });
    await expect(added).toBeVisible();
    await added.getByTitle('更多订阅操作').click();
    await page.getByRole('menuitem', { name: '取消订阅…', exact: true }).click();
    await page.getByRole('button', { name: '确认取消', exact: true }).click();
    await expect(added).toHaveCount(0);
    await page.getByRole('button', { name: '选择连接 Staging Broker', exact: true }).click();
    await expect(subscriptions).toContainText('devices/+/status');
    await expect(subscriptions.locator('.subscription-panel__connection')).toHaveText('Staging Broker');
    await page.getByRole('button', { name: '选择连接 Local Lab', exact: true }).click();
    await page.getByPlaceholder('输入目标 Topic...').fill(`commands/${'long-topic-'.repeat(14)}`);
    await page.locator('.cm-content').fill('{"status":"ok","values":[1,2,3]}');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const sent = page.locator('.chat-msg--out').last();
    await expect(sent).toContainText('↑ 发送');
    await expect(sent).toHaveCSS('align-self', 'flex-end');
    await expect(page.locator('.chat-msg--in').first()).toHaveCSS('align-self', 'flex-start');
    await expect(sent.locator('.chat-msg__bubble')).toHaveCSS('white-space', 'pre-wrap');
    await expect(sent.locator('.chat-msg__bubble')).toContainText('values');
    await sent.getByRole('button', { name: '复制消息', exact: true }).click();
    await expect.poll(() => page.evaluate(() => globalThis.__copiedText)).toContain('values');
    await sent.locator('.chat-msg__bubble').click();
    await expect(page.locator('.message-inspector')).toContainText('values');
    await page.keyboard.press('Escape');
    await assertColumns(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath('collapsed-chat.png') });
  });
}

for (const width of [960, 1440]) {
  test(`${width}: subscription filters preserve TX and hidden sends can be revealed`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 720 });
    await page.addInitScript({ content: `(${installPreviewAdapter.toString()})();` });
    await page.goto(`/?visualRuntime=${testInfo.project.metadata.runtime || 'electron'}`);
    const subscription = page.getByRole('button', { name: '筛选订阅 sensors/#', exact: true });
    const direction = page.getByLabel('消息方向');
    const search = page.getByLabel('搜索 Topic（收发均生效）');
    await subscription.click();
    await page.getByPlaceholder('输入目标 Topic...').fill('commands/relay');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.chat-msg--in')).toHaveCount(2);
    await expect(page.locator('.chat-msg--out')).toHaveCount(1);
    await expect(page.locator('.msg-filter-chip')).toContainText('接收订阅：sensors/#');
    await expect(page.locator('.publish-bar__notice')).toHaveCount(0);

    await direction.selectOption('in');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.chat-msg--out')).toHaveCount(0);
    await expect(page.locator('.publish-bar__notice')).toContainText('已发送，当前筛选未显示');
    await expect(page.getByRole('button', { name: '查看已发送', exact: true })).toBeInViewport();
    await assertColumns(page);
    await page.screenshot({ path: testInfo.outputPath('hidden-send-notice.png') });
    await page.getByRole('button', { name: '查看已发送', exact: true }).click();
    await expect(direction).toHaveValue('out');
    await expect(subscription).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.chat-msg--out')).toHaveCount(2);
    await expect(page.locator('.chat-msg--in')).toHaveCount(0);

    await direction.selectOption('all');
    await search.fill('sensors');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.publish-bar__notice')).toBeVisible();
    await page.getByRole('button', { name: '查看已发送', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(page.locator('.chat-msg--out')).toHaveCount(3);
    await expect(page.locator('.publish-bar__notice')).toHaveCount(0);
    await direction.selectOption('all');
    await expect(page.locator('.chat-msg--in')).toHaveCount(2);
    await expect(page.locator('.chat-msg--out')).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath('subscription-with-sent-messages.png') });

    await direction.selectOption('in');
    await page.getByRole('button', { name: '选择连接 Staging Broker', exact: true }).click();
    await expect(page.locator('.publish-bar__notice')).toHaveCount(0);
    await expect(page.locator('.chat-msg--out')).toHaveCount(0);
  });
}

async function assertColumns(page) {
  const boxes = await page.locator('.mqtt-app').evaluate(app => {
    const connection = app.querySelector('.left-panel').getBoundingClientRect();
    const subscription = app.querySelector('.subscription-panel').getBoundingClientRect();
    const main = app.querySelector('.main-area');
    return { connectionRight: connection.right, subscriptionLeft: subscription.left,
      subscriptionRight: subscription.right, mainLeft: main.getBoundingClientRect().left,
      fits: main.scrollWidth <= main.clientWidth && app.scrollWidth <= app.clientWidth };
  });
  expect(boxes.subscriptionLeft).toBeCloseTo(boxes.connectionRight, 0);
  expect(boxes.mainLeft).toBeCloseTo(boxes.subscriptionRight, 0);
  expect(boxes.fits).toBe(true);
}


function installManySubscriptions() {
  const adapter = globalThis.__INEED_VISUAL_ADAPTER__;
  const list = adapter.subscription.list;
  adapter.subscription.list = async connectionId => {
    if (connectionId !== 'connection-1') return [];
    const [sample] = await list(connectionId);
    return Array.from({ length: 30 }, (_, index) => ({ ...sample, id: `sub-many-${index}`, topic: `devices/${index}/#` }));
  };
}

test('many subscriptions scroll independently and an empty connection keeps the add action available', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 960, height: 600 });
  await page.addInitScript({ content: `(${installPreviewAdapter.toString()})(); (${installManySubscriptions.toString()})();` });
  await page.goto(`/?visualRuntime=${testInfo.project.metadata.runtime || 'electron'}`);
  const panel = page.getByRole('complementary', { name: '当前连接的订阅' });
  await expect(panel.locator('.sub-item')).toHaveCount(30);
  const rowsFit = await panel.locator('.sub-list').evaluate(list => {
    const rows = [...list.querySelectorAll('.sub-item')];
    return list.scrollHeight > list.clientHeight && rows.every(row => row.scrollHeight <= row.clientHeight);
  });
  expect(rowsFit).toBe(true);
  await panel.getByRole('button', { name: '筛选订阅 devices/29/#', exact: true }).click();
  await expect(panel.getByRole('button', { name: '筛选订阅 devices/29/#', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTitle('添加订阅')).toBeInViewport();
  await page.getByRole('button', { name: '折叠连接列表' }).click();
  await page.getByRole('button', { name: '选择连接 Staging Broker', exact: true }).click();
  await expect(panel.locator('.subscription-panel__empty')).toBeVisible();
  await panel.getByTitle('添加订阅').click();
  await expect(page.getByRole('dialog', { name: '添加订阅', exact: true })).toBeVisible();
});


function installLongSubscriptions() {
  const adapter = globalThis.__INEED_VISUAL_ADAPTER__;
  const list = adapter.subscription.list;
  adapter.subscription.list = async connectionId => {
    const rows = await list(connectionId);
    if (connectionId !== 'connection-1') return rows;
    return Array.from({ length: 12 }, (_, index) => ({ ...rows[0], id: `long-${index}`,
      topic: `/factory/line-${index}/equipment/temperature/+/telemetry/#`, format: index % 3 ? 'json' : 'hex' }));
  };
}

test('long subscriptions, keyboard menus and persistent column resizing stay usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1120, height: 720 });
  await page.addInitScript({ content: `(${installPreviewAdapter.toString()})(); (${installLongSubscriptions.toString()})();` });
  await page.goto(`/?visualRuntime=${testInfo.project.metadata.runtime || 'electron'}`);
  await page.evaluate(() => {
    const style = globalThis.document.querySelector('style[data-visual-fixture]');
    style.textContent = style.textContent.replace(/^.*font-family.*$/gm, '');
  });
  const panel = page.locator('.subscription-panel');
  const topic = panel.locator('.sub-item__topic').first();
  await expect(topic).toHaveAttribute('title', '/factory/line-0/equipment/temperature/+/telemetry/#');
  const dimensions = await topic.evaluate(node => ({ height: node.clientHeight, line: parseFloat(globalThis.getComputedStyle(node).lineHeight) }));
  expect(dimensions.height).toBeGreaterThan(dimensions.line);
  expect(dimensions.height).toBeLessThanOrEqual(dimensions.line * 2 + 1);
  await expect(panel.locator('.sub-item__actions').first().getByRole('button')).toHaveCount(2);
  const footer = page.locator('.left-bottom');
  await expect(footer.getByRole('button', { name: '设置', exact: true })).toBeInViewport();
  await expect(footer.getByRole('button', { name: '关于', exact: true })).toBeInViewport();
  const aligned = await footer.evaluate(node => {
    const buttons = [...node.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    return buttons[0].left - node.getBoundingClientRect().left < 20 && buttons[1].right < node.getBoundingClientRect().right - 20;
  });
  expect(aligned).toBe(true);
  const separator = page.getByRole('separator', { name: '调整订阅栏宽度' });
  await expect(separator).toHaveAttribute('aria-valuenow', '260');
  const grip = await separator.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, 200);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 40, 200);
  await page.mouse.up();
  await expect(separator).toHaveAttribute('aria-valuenow', '300');
  await page.reload();
  await expect(separator).toHaveAttribute('aria-valuenow', '300');
  await separator.press('ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', '290');
  await separator.press('Home');
  await expect(separator).toHaveAttribute('aria-valuenow', '260');
  await page.getByRole('button', { name: '折叠连接列表' }).click();
  await assertColumns(page);
  const more = panel.getByTitle('更多订阅操作').last();
  await more.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeInViewport();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await page.locator('.subscription-panel__connection').click();
  await expect(menu).toHaveCount(0);
  await panel.locator('.sub-list').evaluate(node => { node.scrollTop = 0; });
  await panel.locator('.sub-item__select').first().click();
  await page.evaluate(() => {
    const style = globalThis.document.querySelector('style[data-visual-fixture]');
    style.textContent = style.textContent.replace(/^.*font-family.*$/gm, '');
  });
  await page.getByRole('button', { name: '展开连接列表' }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: testInfo.outputPath('subscription-refined.png') });
  await page.setViewportSize({ width: 960, height: 600 });
  await separator.press('End');
  await assertColumns(page);
  await panel.getByTitle('更多订阅操作').first().click();
  await page.getByRole('button', { name: '选择连接 Staging Broker', exact: true }).click();
  await expect(menu).toHaveCount(0);
});
