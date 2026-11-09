import {mkdir,writeFile} from 'node:fs/promises';
import {expect,test} from '@playwright/test';
import {installPreviewAdapter} from './fixtures/previewAdapter.js';
async function measure(panel) {
  return panel.evaluate(root => {
    const formRows = [...root.querySelectorAll('.modal__row')];
    const controls = [...root.querySelectorAll('input:not([type=checkbox]):not([type=radio]), select')].filter(n => n.getBoundingClientRect().width > 0);
    return controls.map(n => { const r=n.getBoundingClientRect(); const p=n.parentElement.getBoundingClientRect(); return {name:n.name || n.getAttribute('aria-label') || n.parentElement.textContent.trim().slice(0,55), tag:n.tagName,type:n.type,row:formRows.indexOf(n.closest('.modal__row')),fill:n.parentElement.matches('.modal__field, .field-control'),x:r.x,y:r.y,w:r.width,h:r.height,parentX:p.x,parentY:p.y,parentW:p.width,overflow:n.scrollWidth > n.clientWidth+1}; });
  });
}
async function inspect(panel, info, name) {
  const bounds=await panel.boundingBox();
  if(await panel.getAttribute('role')==='dialog') {
    expect(bounds.y,'dialog top').toBeGreaterThanOrEqual(-1);
    expect(bounds.y+bounds.height,'dialog bottom').toBeLessThanOrEqual(panel.page().viewportSize().height+1);
    const footer=panel.locator(':scope > footer, :scope > .modal__footer');
    if(await footer.count()) {
      const f=await footer.boundingBox();
      expect(f.y+f.height,'footer stays inside dialog').toBeLessThanOrEqual(bounds.y+bounds.height+1);
    }
    const horizontal=await panel.evaluate(n=>n.scrollWidth-n.clientWidth);
    expect(horizontal,'no dialog horizontal overflow').toBeLessThanOrEqual(1);
  }
  const rows=await measure(panel);
  await mkdir(info.outputDir,{recursive:true});
  await writeFile(info.outputPath(name+'.json'),JSON.stringify(rows,null,2));
  await info.attach(name, {body:JSON.stringify(rows,null,2),contentType:'application/json'});
  for (const r of rows) {
    expect(r.h, r.name+' height').toBeGreaterThan(20);
    expect(r.x, r.name+' left edge').toBeGreaterThanOrEqual(r.parentX-1);
    expect(r.x+r.w, r.name+' right edge').toBeLessThanOrEqual(r.parentX+r.parentW+1);
  }
  for (let i=0;i<rows.length;i++) {
    const a=rows[i];
    if(a.fill) expect(Math.abs(a.w-a.parentW),a.name+' fills field').toBeLessThanOrEqual(1);
    for(const b of rows.slice(i+1)) {
      if((a.row >= 0 && a.row === b.row) || (Math.abs(a.parentY-b.parentY)<1 && Math.abs(a.parentW-b.parentW)<1 && Math.abs(a.x-b.x)>5)) {
        expect(Math.abs(a.y-b.y),a.name+' / '+b.name+' paired tops').toBeLessThanOrEqual(1);
        expect(Math.abs(a.h-b.h),a.name+' / '+b.name+' paired heights').toBeLessThanOrEqual(1);
      }
    }
  }
  return rows;
}

for(const width of [1440,920]) for(const dark of [false,true]) for(const large of [false,true]) for(const collapsed of [false,true]) {
 test(`${width} dark=${dark} large=${large} collapsed=${collapsed} forms`,async({page},info)=>{
  await page.setViewportSize({width,height:width===1440?900:620});
  await page.addInitScript({content:`(${installPreviewAdapter.toString()})();`});
  await page.goto('/?visualRuntime='+info.project.metadata.runtime);
  await page.evaluate(()=>{
    const style=globalThis.document.querySelector('style[data-visual-fixture]');
    style.textContent=style.textContent.replace(/^.*font-family.*$/gm,'');
  });
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'设置',exact:true});
  await settings.getByRole('switch',{name:'大字模式'}).setChecked(large);
  await settings.getByLabel('主题',{exact:true}).selectOption(dark?'dark':'light');
  await inspect(settings,info,'settings');
  await settings.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByTitle('新建连接',{exact:true}).click();
  const dialog=page.getByRole('dialog');
  // New-connection action belongs to the expanded sidebar; retain a collapsed background fixture.
  if(collapsed) await page.getByRole('button',{name:'折叠连接列表',exact:true}).evaluate(button=>button.click());
  await dialog.getByLabel('协议', {exact:true}).selectOption('ws://');
  await dialog.getByLabel('主机地址', {exact:true}).fill('::1');
  await dialog.getByLabel('WebSocket 路径', {exact:true}).fill('/tenant/mqtt?x=1');
  const rows=await inspect(dialog,info,'connection');
  const pair=rows.filter(r=>['协议','主机地址','端口'].includes(r.name));
  expect(Math.max(...pair.map(r=>r.y))-Math.min(...pair.map(r=>r.y))).toBeLessThanOrEqual(1);
  expect(Math.max(...pair.map(r=>r.h))-Math.min(...pair.map(r=>r.h))).toBeLessThanOrEqual(1);
  await dialog.getByLabel('主机地址',{exact:true}).fill('');
  await dialog.getByLabel('端口',{exact:true}).focus();
  await inspect(dialog,info,'connection-error');
  await page.screenshot({path:info.outputPath('connection.png')});
  await page.keyboard.press('Escape');
  // Edit and copy have independent dialog markup; cover their fields as well.
  if(collapsed) await page.getByRole('button',{name:'展开连接列表',exact:true}).click();
  await page.getByTitle('编辑连接',{exact:true}).first().click();
  await inspect(page.getByRole('dialog'),info,'connection-edit');
  await page.keyboard.press('Escape');
  if(collapsed) await page.getByRole('button',{name:'折叠连接列表',exact:true}).click();
  await page.getByTitle('添加订阅',{exact:true}).click();
  await inspect(page.getByRole('dialog'),info,'subscription');
  await page.screenshot({path:info.outputPath('subscription.png')});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'更多订阅操作 sensors/#',exact:true}).click();
  await page.getByRole('menuitem',{name:'复制到连接…',exact:true}).click();
  await inspect(page.getByRole('dialog'),info,'subscription-copy');
  await page.screenshot({path:info.outputPath('subscription-copy.png')});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'定时发送',exact:true}).click();
  await inspect(page.getByRole('group',{name:'定时发送设置'}),info,'composer-schedule');
 });
}

async function verifyScrollFocus(control, scroller, info, name, requireScroll = true) {
  const before = await scroller.evaluate(n => ({ top: n.scrollTop, height: n.clientHeight, content: n.scrollHeight }));
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  await expect(control).toBeFocused();
  const field = await control.boundingBox();
  const viewport = await scroller.boundingBox();
  expect(field.y, name + ' top in scroll viewport').toBeGreaterThanOrEqual(viewport.y - 1);
  expect(field.y + field.height, name + ' bottom in scroll viewport').toBeLessThanOrEqual(viewport.y + viewport.height + 1);
  await expect(control).toBeInViewport({ ratio: 1 });
  const after = await scroller.evaluate(n => ({ top: n.scrollTop, height: n.clientHeight, content: n.scrollHeight }));
  if (requireScroll) {
    expect(before.content, name + ' really overflows').toBeGreaterThan(before.height);
    expect(after.top, name + ' actually scrolled').toBeGreaterThan(before.top);
  }
  await mkdir(info.outputDir, { recursive: true });
  await writeFile(info.outputPath(name + '.json'), JSON.stringify({ before, after, field, viewport }, null, 2));
  await control.page().screenshot({ path: info.outputPath(name + '.png') });
}
async function tabToAction(page, action, container) {
  for (let count = 0; count < 40; count += 1) {
    await page.keyboard.press('Tab');
    expect(await container.evaluate(n => n.contains(n.ownerDocument.activeElement)), 'focus remains in form').toBe(true);
    if (await action.evaluate(n => n === n.ownerDocument.activeElement)) break;
  }
  await expect(action).toBeFocused();
  await expect(action).toBeInViewport({ ratio: 1 });
}

test('focused scroll narrow large form reachability', async ({ page }, info) => {
  await page.setViewportSize({ width: 920, height: 620 });
  await page.addInitScript({ content: `(${installPreviewAdapter.toString()})();` });
  await page.goto('/?visualRuntime=' + info.project.metadata.runtime);
  await page.evaluate(() => {
    const style = globalThis.document.querySelector('style[data-visual-fixture]');
    style.textContent = style.textContent.replace(/^.*font-family.*$/gm, '');
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.getByRole('switch', { name: '大字模式' }).setChecked(true);
  await dialog.getByLabel('主题', { exact: true }).selectOption('dark');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const last = dialog.locator('input:not([type=checkbox]):not([type=radio]):enabled:visible, select:enabled:visible').last();
  await verifyScrollFocus(last, dialog.locator('.settings-area'), info, 'settings-last-control');
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  await tabToAction(page, cancel, dialog);
  await page.screenshot({ path: info.outputPath('settings-footer-focused.png') });
  await cancel.click();
  await page.getByTitle('新建连接', { exact: true }).click();
  dialog = page.getByRole('dialog');
  await verifyScrollFocus(dialog.getByLabel('Keep Alive (秒)', { exact: true }), dialog.locator('.modal__body'), info, 'connection-last-control', false);
  await tabToAction(page, dialog.getByRole('button', { name: '取消', exact: true }), dialog);
  await page.screenshot({ path: info.outputPath('connection-footer-focused.png') });
});
