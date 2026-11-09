/* global window, document, getComputedStyle */
import { expect,test } from '@playwright/test';
import { installPreviewAdapter } from './fixtures/previewAdapter.js';
for(const dark of [false,true])for(const large of [false,true])for(const collapsed of [false,true])for(const width of [1440,920])test(`scenarios dark=${dark} large=${large} collapsed=${collapsed} width=${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:width===1440?900:620});
 await page.addInitScript({content:`(${installPreviewAdapter.toString()})();`});
 await page.goto('/?visualRuntime='+info.project.metadata.runtime);
 await page.evaluate(()=>{const style=document.querySelector('style[data-visual-fixture]');style.textContent=style.textContent.replace(/^.*font-family.*$/gm,'');});
 await page.getByRole('button',{name:'设置',exact:true}).click();const settings=page.getByRole('dialog',{name:'设置',exact:true});
 await settings.getByRole('switch',{name:'大字模式'}).setChecked(large);await settings.getByLabel('主题',{exact:true}).selectOption(dark?'dark':'light');await settings.getByRole('button',{name:'保存',exact:true}).click();
 if(collapsed)await page.getByRole('button',{name:'折叠连接列表',exact:true}).click();
 await page.getByRole('tab',{name:'场景测试',exact:true}).click();const panel=page.getByRole('region',{name:'设备消息场景测试'});await expect(panel).toBeVisible();
 await panel.getByLabel('场景名称',{exact:true}).fill('Local device acceptance');await panel.getByRole('button',{name:'保存场景',exact:true}).click();await expect(panel.getByRole('status').filter({hasText:'场景已保存'})).toBeVisible();
 const layout=await panel.evaluate(root=>({overflow:root.scrollWidth-root.clientWidth,controls:[...root.querySelectorAll('input,select,textarea')].filter(n=>n.getBoundingClientRect().width>0).map(n=>{const r=n.getBoundingClientRect();const p=n.parentElement.getBoundingClientRect();return {x:r.x,right:r.right,parentX:p.x,parentRight:p.right,height:r.height};})}));
 expect(layout.overflow).toBeLessThanOrEqual(1);for(const r of layout.controls){expect(r.x).toBeGreaterThanOrEqual(r.parentX-1);expect(r.right).toBeLessThanOrEqual(r.parentRight+1);expect(r.height).toBeGreaterThanOrEqual(30);}
 await panel.evaluate(root=>{root.scrollTop=0;});
 const contrast=await panel.evaluate(root=>{
  let background=root;while(getComputedStyle(background).backgroundColor==='rgba(0, 0, 0, 0)'&&background.parentElement)background=background.parentElement;
  const luminance=color=>{const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;};
  const text=luminance(getComputedStyle(root).color);const bg=luminance(getComputedStyle(background).backgroundColor);return(Math.max(text,bg)+.05)/(Math.min(text,bg)+.05);
 });expect(contrast,'panel body text contrast').toBeGreaterThanOrEqual(4.5);
 await page.screenshot({path:info.outputPath('scenarios.png')});
});

test('business response verdicts, immutable reports and JSON export through the shared workbench',async({page},info)=>{
 await page.addInitScript({content:`(${installPreviewAdapter.toString()})();`});
 await page.addInitScript(()=>{
  const adapter=window.ineedMqttAdapter;let receive;window.__scenarioMode='pass';
  const subscribe=adapter.mqtt.onMessages;adapter.mqtt.onMessages=handler=>{receive=handler;return subscribe(handler);};
  adapter.mqtt.publish=async(id,topic,payload)=>{
   const request=JSON.parse(payload);const mode=window.__scenarioMode;
   if(mode!=='timeout'&&mode!=='stop')receive([{connId:id,topic:'devices/unit-1/response',payload:JSON.stringify({...request,status:'ok',temperature:mode==='fail'?99:25}),timestamp:Date.now(),retained:false,qos:1}]);
   return {ok:true};
  };
 });
 await page.goto('/?visualRuntime='+info.project.metadata.runtime);await page.getByRole('tab',{name:'场景测试',exact:true}).click();const panel=page.getByRole('region',{name:'设备消息场景测试'});
 await panel.getByRole('button',{name:'执行当前草稿',exact:true}).click();await expect(panel.getByRole('heading',{name:'通过 · 设备指令响应',exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'导出结果 JSON'}).click();
 const text=await panel.getByLabel('导出 JSON 内容',{exact:true}).inputValue();const report=JSON.parse(text);expect(report.status).toBe('pass');expect(report.requestId).toBeTruthy();expect(report.connection).toEqual({id:'connection-1',name:'Local Lab'});expect(report.evidence[0].reason).toBe('matched');
 await panel.getByRole('button',{name:'复制 JSON',exact:true}).click();await expect(panel.getByRole('status').filter({hasText:'JSON 已复制'})).toBeVisible();
 if(info.project.metadata.runtime==='electron') {const download=page.waitForEvent('download');await panel.getByRole('button',{name:'下载 JSON 文件'}).click();const stream=await(await download).createReadStream();let downloaded='';for await(const chunk of stream)downloaded+=chunk;expect(downloaded).toBe(text);}
 else await expect(panel.getByRole('button',{name:'下载 JSON 文件'})).toHaveCount(0);
 await panel.getByRole('button',{name:'关闭导出'}).click();
 for(const [mode,label] of [['fail','失败'],['timeout','超时'],['stop','已停止']]) {
  await page.evaluate(mode=>{window.__scenarioMode=mode;},mode);await panel.getByLabel('场景超时',{exact:true}).fill(mode==='timeout'?'100':'5000');
  await expect(panel.getByRole('button',{name:'执行当前草稿',exact:true})).toBeEnabled();await panel.getByRole('button',{name:'执行当前草稿',exact:true}).click();if(mode==='stop')await panel.getByRole('button',{name:'停止',exact:true}).click();
  await expect(panel.getByRole('heading',{name:label+' · 设备指令响应',exact:true})).toBeVisible();
 }
});
