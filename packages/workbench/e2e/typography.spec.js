import { expect, test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';

function installFontSettings() {
  const adapter = globalThis.__INEED_VISUAL_ADAPTER__;
  const getAll = adapter.settings.getAll;
  const saved = { largeFont: new globalThis.URLSearchParams(globalThis.location.search).get('fontMode') === 'large' };
  adapter.settings.getAll = async () => ({ ...await getAll(), ...saved });
  adapter.settings.save = async (key, value) => { saved[key] = value; return { ok: true }; };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1120, height: 720 }, { width: 960, height: 600 }]) {
  test(`${viewport.width}: consistent workbench and history typography in both font modes`, async ({ page }, testInfo) => {
    const runtime = testInfo.project.metadata.runtime || 'electron';
    await page.setViewportSize(viewport);
    await page.addInitScript({ content: `(${installPreviewAdapter.toString()})(); (${installFontSettings.toString()})();` });
    async function goto(path) {
      await page.goto(path);
      await page.evaluate(() => {
        const style = globalThis.document.querySelector('style[data-visual-fixture]');
        style.textContent = style.textContent.replace(/^.*font-family.*$/gm, '');
      });
    }
    await goto(`/?visualRuntime=${runtime}`);
    const samples = [];
    for (const large of [false, true]) {
      if (large) {
        await page.getByRole('button', { name: '设置', exact: true }).click();
        const settings = page.getByRole('dialog', { name: '设置', exact: true });
        await settings.getByRole('switch', { name: '大字模式' }).click();
        await settings.getByRole('button', { name: '保存', exact: true }).click();
      }
      const sizes = {};
      async function collect(prefix, selectors) {
        for (const [role, selector] of Object.entries(selectors)) {
          const element = page.locator(selector).first();
          await expect(element).toBeVisible();
          sizes[`${prefix}.${role}`] = await element.evaluate(node => Number.parseFloat(globalThis.getComputedStyle(node).fontSize));
        }
      }
      await collect('workbench', {
        connection: '.conn-item__name', subscription: '.sub-item__topic', tab: '.workspace-tabs button',
        time: '.chat-msg__time', payload: '.chat-msg__bubble', editor: '.cm-scroller', input: '.resource-search',
      });
      const messageTime = page.locator('.chat-msg__time').first();
      await expect(messageTime).toHaveText(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
      const fullTime = await messageTime.getAttribute('title');
      expect(fullTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      await page.locator('.chat-msg__bubble').first().click();
      await expect(page.locator('.message-inspector dl')).toContainText(fullTime);
      await collect('inspector', { code: '.message-inspector pre' });
      await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: '日志', exact: true }).click();
      await collect('logs', { data: '.log-line', time: '.log-line__time' });
      await expect(page.locator('.log-line__time').first()).toHaveText(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
      await expect(page.locator('.log-line__time').first()).toHaveAttribute('title', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
      await page.getByRole('tab', { name: '消息', exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await collect('settings', { title: '.settings-dialog h3', label: '.settings-row__label', note: '.settings-row__desc', input: '.settings-row select' });
      await page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
      await page.getByTitle('新建连接', { exact: true }).click();
      await collect('connection', { title: '.modal__header h3', label: '.modal__field label', input: '.modal__field input' });
      await page.keyboard.press('Escape');
      await page.getByTitle('添加订阅', { exact: true }).click();
      await collect('subscription', { title: '.modal__header h3', label: '.modal__field label', input: '.modal__field input' });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '关于', exact: true }).click();
      await collect('about', { title: '.desktop-about h2', data: '.about-panel__details dd', button: '.about-panel__button' });
      await page.getByRole('dialog', { name: '关于', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
      expect(sizes['connection.input']).toBe(sizes['subscription.input']);
      expect(sizes['connection.input']).toBe(sizes['settings.input']);
      expect(sizes['workbench.payload']).toBe(sizes['workbench.editor']);
      expect(sizes['inspector.code']).toBe(sizes['workbench.editor']);
      samples.push(sizes);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: testInfo.outputPath(`workbench-${large ? 'large' : 'normal'}.png`) });
    }
    for (const key of Object.keys(samples[0])) expect(samples[1][key], `${key} should grow`).toBeGreaterThan(samples[0][key]);
    for (const kind of ['messages', 'logs']) {
      for (const [index, mode] of ['normal', 'large'].entries()) {
        await goto(`/?history=${kind}&visualRuntime=${runtime}&fontMode=${mode}`);
        await expect(page.locator('.history-row').first()).toBeVisible();
        await expect(page.locator('.history-list__head')).toHaveCSS('font-size', `${samples[index]['workbench.tab']}px`);
        await expect(page.locator('.history-row').first()).toHaveCSS('font-size', `${samples[index]['logs.data']}px`);
        await expect(page.locator('.history-filters input').first()).toHaveCSS('font-size', `${samples[index]['connection.input']}px`);
        await expect(page.locator('.history-detail pre')).toHaveCSS('font-size', `${samples[index]['workbench.editor']}px`);
        await page.screenshot({ path: testInfo.outputPath(`history-${kind}-${mode}.png`) });
      }
    }
  });
}
