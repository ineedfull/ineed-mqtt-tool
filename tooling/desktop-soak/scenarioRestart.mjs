/* global window, document */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { _electron as electron } from '@playwright/test';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';
import { prepareTauriSoakExecutable } from './tauriExecutable.mjs';
import { startLocalBroker } from '../mqtt-load-test/localBroker.mjs';

const root = fileURLToPath(new URL('../../',import.meta.url));
const out = process.env.SCENARIO_OUT;
assert.ok(out,'SCENARIO_OUT required');
const previous=JSON.parse(await readFile(join(out,'result.json'),'utf8'));
assert.equal(previous.passed,true);
const broker=await startLocalBroker();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let app,native;
// Ordinary window/production renderer startup; no MQTT operations or clipboard.
async function installDesktopSoak() {
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const end=performance.now()+15000;
  const wait=async predicate=>{while(!predicate()){if(performance.now()>end)throw new Error('restart UI deadline');await delay(30);}};
  await wait(()=>document.querySelector('.mqtt-app'));
  const tab=[...document.querySelectorAll('[role="tab"]')].find(el=>el.textContent.trim()==='场景测试');tab.click();
  await wait(()=>document.querySelector('[aria-label="场景历史报告"]')?.options.length===31);
  const result={reports:[...document.querySelector('[aria-label="场景历史报告"]').options].slice(1).map(o=>o.value),
    scenarios:document.querySelector('[aria-label="已保存场景"]').options.length-1,visibility:document.visibilityState,
    heading:document.querySelector('.scenario-results h3')?.textContent,report:JSON.parse(document.querySelector('.scenario-results pre').textContent)};
  if(window.__TAURI_INTERNALS__)await window.__TAURI_INTERNALS__.invoke('desktop_soak_report',{id:'ready',result});
  return result;
}
try {
  const env={...process.env,INEED_CLIPBOARD_TEST_USER_DATA:join(previous.profileRoot,'electron-profile')};
  for(const key of ['ELECTRON_RUN_AS_NODE','VITE_DEV_SERVER_URL','INEED_SMOKE_TEST'])delete env[key];
  app=await electron.launch({executablePath:await prepareElectronExecutable(),args:[join(root,'apps/electron/tests/fixtures/clipboardHarness.cjs')],env,timeout:20000});
  const page=await app.firstWindow();await page.waitForSelector('.mqtt-app');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:0,y:40,width:1120,height:780}));
  const e=await page.evaluate(installDesktopSoak);
  const driver=join(previous.profileRoot,'restart-driver.js');await writeFile(driver,installDesktopSoak.toString());
  native=spawn(await prepareTauriSoakExecutable(root,previous.profileRoot),[],{env:{...process.env,INEED_DESKTOP_SOAK_PROFILE:join(previous.profileRoot,'tauri-profile'),INEED_DESKTOP_SOAK_PORT:String(broker.port),INEED_DESKTOP_SOAK_DRIVER:driver,INEED_DESKTOP_SOAK_HIDDEN:'0',INEED_DESKTOP_SOAK_WINDOW:JSON.stringify({x:0,y:40,width:1120,height:780})},stdio:['pipe','pipe','pipe']});
  let buffer='',stderr='';native.stderr.on('data',c=>{stderr+=c;});
  const t=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('native restart deadline '+stderr)),25000);
    native.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.startsWith('SOAK ')){const report=JSON.parse(line.slice(5));if(report.id==='ready'){clearTimeout(timeout);resolve(report.result);}}}});
  });
  for(const [i,result]of[e,t].entries()){
    assert.equal(result.failed,undefined,JSON.stringify(result));assert.equal(result.visibility,'visible');assert.equal(result.scenarios,2);assert.deepEqual(result.reports,previous.final[i].reportIds);assert.equal(result.report.runId,previous.final[i].latest.runId);assert.equal(result.report.cleanup,'released-or-deferred');
  }
  await page.screenshot({path:join(out,'electron-after-process-restart.png')});
  await writeFile(join(out,'process-restart.json'),JSON.stringify({passed:true,electron:e,tauri:t,profileRoot:previous.profileRoot,newProcessIds:{electron:app.process().pid,tauri:native.pid}},null,2));
  console.log('Both native desktop process restarts restored 2 scenarios, 30 identical reports and latest raw evidence.');
} finally {
  if(native){native.stdin.write('EXIT\n');await delay(700);if(native.exitCode===null)native.kill();}
  await app?.close();await broker.close();
  await writeFile(join(out,'restart-cleanup.json'),JSON.stringify({brokerClosed:broker.isClosed,brokerSockets:broker.openSocketCount}));
}
