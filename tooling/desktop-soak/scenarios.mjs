/* global window, document */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from '@playwright/test';
import mqtt from 'mqtt';
import { startLocalBroker } from '../mqtt-load-test/localBroker.mjs';
import { prepareTauriSoakExecutable } from './tauriExecutable.mjs';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = process.env.SCENARIO_OUT || await mkdtemp('/tmp/mqtt-scenario-soak-');
const seconds = Number(process.env.SCENARIO_SECONDS || 1200);
const idleSeconds = Number(process.env.SCENARIO_IDLE_SECONDS || 180);
await mkdir(out, { recursive: true });
const profileRoot = await mkdtemp('/tmp/mqtt-scenario-profiles-');
const broker = await startLocalBroker();
const device = await mqtt.connectAsync(`mqtt://${broker.host}:${broker.port}`, { username: broker.username, password: broker.password, reconnectPeriod: 0 });
let requests = 0, responses = 0, app, native, clipboardSaved = false;
const errors = [], nativeLogs = [], pending = new Map(), samples = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const awake = spawn('caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' });
await device.subscribeAsync('scenario/+/command', { qos: 1 });
device.on('message', async (topic, bytes) => {
  try {
    const request = JSON.parse(bytes.toString()); requests++;
    const responseTopic = topic.replace(/command$/, 'response');
    if (['timeout', 'stopped', 'connection-loss'].includes(request.mode)) return;
    const reply = { requestId: request.requestId, status: 'ok', temperature: request.mode === 'fail' ? 99 : 25 };
    if (request.mode === 'noisy') {
      await device.publishAsync(responseTopic, JSON.stringify({ ...reply, requestId: 'late-previous-run' }), { qos: 1 }); responses++;
      await delay(25);
    }
    await device.publishAsync(responseTopic, JSON.stringify(reply), { qos: 1 }); responses++;
    if (request.mode === 'noisy') { await delay(80); await device.publishAsync(responseTopic, JSON.stringify(reply), { qos: 1 }); responses++; }
  } catch(e) { errors.push(String(e.stack || e)); }
});
for (const runtime of ['electron', 'tauri']) await device.publishAsync(`scenario/${runtime}/response`, JSON.stringify({ requestId: 'retained-previous', status: 'ok', temperature: 25 }), { qos: 1, retain: true });
function resources() {
  const rows = execFileSync('ps', ['-axo','pid=,ppid=,%cpu=,rss=,comm='], { encoding:'utf8' }).trim().split('\n').map(line => {
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);return m&&{pid:+m[1],ppid:+m[2],cpuPercent:+m[3],rssKiB:+m[4],command:m[5]};
  }).filter(Boolean);
  function tree(pid) {const ids=new Set([pid]);let added;do{added=false;for(const r of rows)if(ids.has(r.ppid)&&!ids.has(r.pid)){ids.add(r.pid);added=true;}}while(added);return rows.filter(r=>ids.has(r.pid));}
  return {electron:tree(app.process().pid),tauri:tree(native.pid),webkitSystem:rows.filter(r=>/WebKit/.test(r.command))};
}
function nativeCommand(op) {
  const id = `${op}-${crypto.randomUUID()}`;
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`native ${op} timeout`));},30000);
    pending.set(id,result=>{clearTimeout(timer);resolve(result);});native.stdin.write(JSON.stringify({id,op})+'\n');
  });
}
try {
  const driver=await readFile(join(root,'tooling/desktop-soak/scenarioDriver.js'),'utf8');
  const driverPath=join(profileRoot,'scenario-driver.js');await writeFile(driverPath,driver);
  const env={...process.env,INEED_CLIPBOARD_TEST_USER_DATA:join(profileRoot,'electron-profile')};
  for(const key of ['ELECTRON_RUN_AS_NODE','VITE_DEV_SERVER_URL','INEED_SMOKE_TEST'])delete env[key];
  app=await electron.launch({executablePath:await prepareElectronExecutable(),args:[join(root,'apps/electron/tests/fixtures/clipboardHarness.cjs')],env,timeout:20000});
  const page=await app.firstWindow();
  await page.waitForSelector('.mqtt-app');
  await page.evaluate(async port=>{await window.ineedMqtt.db.saveConnection({id:'desktop-soak',name:'Scenario acceptance',host:'127.0.0.1',port,protocol:'mqtt',username:'compat-user',password:'compat-pass',client_id:'scenario-desktop-electron',clean_session:1,auto_reconnect:0});},broker.port);
  await page.reload();
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setBounds({x:0,y:30,width:1120,height:780});w.setAlwaysOnTop(true);w.show();});
  await page.evaluate(driver+'\ninstallDesktopSoak({runtime:"electron"})');
  const ready=new Promise(resolve=>pending.set('ready',resolve));
  native=spawn(await prepareTauriSoakExecutable(root,profileRoot),[],{env:{...process.env,INEED_DESKTOP_SOAK_PROFILE:join(profileRoot,'tauri-profile'),INEED_DESKTOP_SOAK_PORT:String(broker.port),INEED_DESKTOP_SOAK_DRIVER:driverPath,INEED_DESKTOP_SOAK_HIDDEN:'0',INEED_DESKTOP_SOAK_KEEP_VISIBLE:'1',INEED_DESKTOP_SOAK_WINDOW:JSON.stringify({x:400,y:80,width:1120,height:780})},stdio:['pipe','pipe','pipe']});
  let buffer='';native.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);nativeLogs.push(line);if(line.startsWith('SOAK ')){const v=JSON.parse(line.slice(5)),done=pending.get(v.id);if(done){pending.delete(v.id);done(v.result);}}}});
  native.stderr.on('data',chunk=>nativeLogs.push(String(chunk)));
  const readyResult=await Promise.race([ready,delay(25000).then(()=>{throw new Error('native ready deadline '+nativeLogs.join('\n'));})]);assert.equal(readyResult.ready,true,JSON.stringify(readyResult));
  async function command(op) {const result=await Promise.all([page.evaluate(op=>window.desktopSoakCommand({op}),op),nativeCommand(op)]);result[0].nativeWindow=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return {visible:w.isVisible(),minimized:w.isMinimized(),bounds:w.getBounds()};});for(const r of result){assert.equal(r.failed,undefined,JSON.stringify(r));assert.deepEqual(r.errors,[]);assert.equal(r.nativeWindow.visible,true,JSON.stringify(r.nativeWindow));assert.equal(r.nativeWindow.minimized,false,JSON.stringify(r.nativeWindow));assert.ok(r.width>0,JSON.stringify({visibility:r.visibility,nativeWindow:r.nativeWindow}));assert.equal(r.visibility,'visible');}return result;}
  // The parent grants an exclusive clipboard slot before invoking this script.
  await app.evaluate(({clipboard})=>{globalThis.__scenarioClipboard=clipboard.availableFormats().map(format=>[format,clipboard.readBuffer(format)]);});clipboardSaved=true;
  let desktop=[];
  for(const runtime of ['electron','tauri']) {
    const result=runtime==='electron'?await page.evaluate(()=>window.desktopSoakCommand({op:'desktop'})):await nativeCommand('desktop');
    assert.equal(result.failed,undefined,JSON.stringify(result));assert.equal(result.nativeClipboard,true);desktop.push(result);
    await writeFile(join(out,`${runtime}-library.json`),result.libraryText);await writeFile(join(out,`${runtime}-report.json`),result.reportText);
  }
  // Exercise actual Electron download separately while its JSON export is open.
  await page.getByRole('button',{name:'导出场景',exact:true}).click();
  await app.evaluate(({BrowserWindow},savePath)=>{globalThis.__scenarioDownload=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('native download deadline')),10000);BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_event,item)=>{item.setSavePath(savePath);item.once('done',(_e,state)=>{clearTimeout(timeout);resolve({state,filename:item.getFilename(),savePath:item.getSavePath()});});});});},join(out,'electron-library-download.json'));
  await page.getByRole('button',{name:'下载 JSON 文件',exact:true}).click();
  const downloaded=await app.evaluate(()=>globalThis.__scenarioDownload);assert.equal(downloaded.state,'completed');
  await writeFile(join(out,'electron-download.json'),JSON.stringify(downloaded));
  assert.deepEqual(JSON.parse(await readFile(join(out,'electron-library-download.json'),'utf8')).scenarios,desktop[0].importedScenarios);
  await page.getByRole('button',{name:'关闭导出',exact:true}).click();
  await app.evaluate(({clipboard})=>{clipboard.clear();for(const [format,buffer] of globalThis.__scenarioClipboard)clipboard.writeBuffer(format,buffer);});clipboardSaved=false;
  await writeFile(join(out,'desktop-preflight.json'),JSON.stringify(desktop,null,2));
  await page.screenshot({path:join(out,'electron-desktop.png')});
  console.log(JSON.stringify({event:'clipboard-restored-load-starting',out,profileRoot,electronPid:app.process().pid,tauriPid:native.pid}));
  const started=performance.now();let next=0;
  while(performance.now()-started<seconds*1000) {
    const result=await command('batch');
    if(performance.now()-started>=next){const sample={elapsedMs:performance.now()-started,requests,responses,result,resources:resources(),brokerSockets:broker.openSocketCount};samples.push(sample);await writeFile(join(out,'progress.json'),JSON.stringify(samples,null,2));console.log(JSON.stringify({event:'progress',elapsedMs:sample.elapsedMs,runs:result.map(r=>r.runs),requests,responses}));next+=60000;}
    await delay(60);
  }
  const loadElapsedMs=performance.now()-started;
  const idleStarted=performance.now(),idle=[];
  while(performance.now()-idleStarted<idleSeconds*1000){await delay(Math.min(10000,idleSeconds*1000-(performance.now()-idleStarted)));idle.push({elapsedMs:performance.now()-idleStarted,result:await command('snapshot'),resources:resources(),brokerSockets:broker.openSocketCount});await writeFile(join(out,'idle.json'),JSON.stringify(idle,null,2));}
  const idleElapsedMs=performance.now()-idleStarted;
  const final=await command('finish');
  const sqlite={};
  for(const runtime of ['electron','tauri']){
    const db=new DatabaseSync(join(profileRoot,`${runtime}-profile/ineed-mqtt.db`),{readOnly:true});
    const settings=Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,r.value]));
    sqlite[runtime]={quickCheck:db.prepare('PRAGMA quick_check').get(),library:JSON.parse(settings['mqtt.scenarios.v1']),reports:JSON.parse(settings['mqtt.scenarioReports.v1']),pending:settings['mqtt.pendingUnsubscriptions.desktop-soak']};db.close();
    assert.deepEqual(sqlite[runtime].reports.map(r=>r.runId),final[runtime==='electron'?0:1].reportIds);assert.equal(sqlite[runtime].reports.length,30);assert.equal(sqlite[runtime].library.length,2);assert.equal(sqlite[runtime].pending,'[]');assert.deepEqual(Object.values(sqlite[runtime].quickCheck),['ok']);
  }
  await writeFile(join(out,'sqlite.json'),JSON.stringify(sqlite,null,2));
  // A renderer restart exercises the production reload/load path against SQLite.
  await page.reload();await page.getByRole('tab',{name:'场景测试',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="场景历史报告"]')?.options.length===31);
  const restart=await page.locator('.scenario-panel').evaluate(el=>({reports:[...el.querySelector('[aria-label="场景历史报告"]').options].slice(1).map(o=>o.value),scenarios:el.querySelector('[aria-label="已保存场景"]').options.length-1}));
  assert.deepEqual(restart.reports,final[0].reportIds);assert.equal(restart.scenarios,2);
  assert.deepEqual(errors,[]);
  await writeFile(join(out,'result.json'),JSON.stringify({passed:true,loadElapsedMs,idleElapsedMs,seconds,idleSeconds,requests,responses,final,restart,profileRoot,parallelHost:true,errors},null,2));
  console.log(JSON.stringify({event:'passed',loadElapsedMs,idleElapsedMs,requests,responses,runs:final.map(r=>r.runs)}));
} catch(e){await writeFile(join(out,'failure.txt'),String(e.stack||e));console.error(e);process.exitCode=1;}
finally{
  if(clipboardSaved)await app?.evaluate(({clipboard})=>{clipboard.clear();for(const [format,buffer] of globalThis.__scenarioClipboard)clipboard.writeBuffer(format,buffer);}).catch(()=>{});
  if(native){native.stdin.write('EXIT\n');await delay(700);if(native.exitCode===null)native.kill();}
  await app?.close();await device.endAsync(true);await broker.close();awake.kill();
  await writeFile(join(out,'native.log'),nativeLogs.join('\n'));await writeFile(join(out,'cleanup.json'),JSON.stringify({brokerSockets:broker.openSocketCount,brokerClosed:broker.isClosed,clipboardRestored:!clipboardSaved,profileRoot}));
  console.log(JSON.stringify({event:'cleanup',out,brokerSockets:broker.openSocketCount}));
}
