import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProspectingDailyDiscovery } from '/app/components/ProspectingDailyDiscovery.tsx';
function Fixture() { const [tick, rerender] = useState(0); const [busy, setBusy] = useState(false); window.refreshFixture = () => rerender(tick + 1); window.blockFixture = setBusy; return <ProspectingDailyDiscovery campaign={{ id: 'a', status: 'active' }} runs={[]} busy={busy} onDirtyChange={()=>{}} onRun={()=>{window.ran=true}} onSave={async value=>{window.saved=value; return window.success === true}} />; }
createRoot(document.getElementById('root')).render(<Fixture />);
`;
async function createFixture(source = fixture) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'conversation-ui-vite-'));
  const server = await createServer({
    resolve: { dedupe: ['react', 'react-dom'] }, cacheDir, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
    root, configFile: false, logLevel: 'error', plugins: [react(), {
      name: 'conversation-test-fixture',
      resolveId(id) { if (id === '/__conversation-fixture.jsx') return path.join(root, '__conversation-fixture.jsx'); },
      load(id) { if (id === path.join(root, '__conversation-fixture.jsx')) return source; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== '/') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__conversation-fixture.jsx"></script></body></html>'));
        });
      },
    }], server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  return { server, origin, cacheDir };
}

test('daily discovery preserves failed drafts across refresh and disables busy controls', { timeout: 60000 }, async () => {
 const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
 const { server, origin, cacheDir } = await createFixture(); let browser;
 try { browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto(origin);
 const time = page.getByLabel('每日发现时间'); await time.fill('10:30'); await page.getByLabel('每天自动运行').check();
 await page.getByRole('button', {name:'保存设置'}).click(); await page.evaluate(()=>window.refreshFixture());
 assert.equal(await time.inputValue(), '10:30'); assert.equal(await page.getByLabel('每天自动运行').isChecked(), true);
 await page.evaluate(()=>window.blockFixture(true)); await page.waitForFunction(()=>document.querySelector('input[type=time]').disabled); assert.equal(await time.isDisabled(), true); assert.equal(await page.getByRole('button', {name:'立即运行'}).isDisabled(), true);
 await page.evaluate(()=>{window.blockFixture(false);window.success=true}); await page.getByRole('button', {name:'保存设置'}).click();
 assert.deepEqual(await page.evaluate(()=>window.saved), {enabled:true,time:'10:30',timeZone:'Asia/Shanghai',includeNewCandidates:true});
 } finally { await browser?.close(); await server.close(); await rm(cacheDir,{recursive:true,force:true}); }
});

test('workspace keeps confirmed page after network failure and historical run during polling', { timeout: 60000 }, async () => {
 const source = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ProspectingWorkspace} from '/app/components/ProspectingWorkspace.tsx'; createRoot(document.getElementById('root')).render(<ProspectingWorkspace initialSection="screen" />);`;
 const {server,origin,cacheDir}=await createFixture(source); const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href); let browser;
 try { browser=await chromium.launch({headless:true}); const page=await browser.newPage(); let newest=false;
 const run=id=>({id,scheduledFor:'2026-11-08T01:00:00Z',status:'completed',newAccounts:0,newComments:0,newLeads:0,completedJobs:1,totalJobs:1});
 await page.route('**/api/prospecting**',async route=>{const url=new URL(route.request().url()); if(url.searchParams.get('leadPage')==='2') return route.fulfill({status:503,json:{error:'分页失败'}}); return route.fulfill({json:{campaign:{id:'a',title:'任务A',status:'active',requirements:'目标客户',keywords:[],candidates:[],selectedCandidateIds:[],reviewMode:'manual',minIntentScore:70,dailyLimit:10,maxCommentsPerVideo:30},campaigns:[{id:'a',title:'任务A',status:'active'}],leads:[],jobs:[],modelReady:false,discoveryRuns:newest?[run('new'),run('old')]:[run('old')],leadPagination:{page:1,pageSize:30,total:60}}});});
 await page.goto(origin); await page.getByRole('button',{name:'下一页'}).click(); await page.getByRole('alert').waitFor(); assert.match(await page.locator('.prospect-inbox-pagination').first().textContent(),/第 1 页/);
 await page.getByLabel('范围').selectOption('old'); await page.waitForFunction(()=>!document.querySelector('[aria-label=范围]').disabled); newest=true;
 await page.waitForFunction(()=>document.querySelector('[aria-label=范围]').textContent.includes('历史轮次新增')); assert.equal(await page.getByLabel('范围').inputValue(),'old'); assert.match(await page.getByLabel('范围').locator('option:checked').textContent(),/历史轮次新增/);
 } finally {await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('creating campaign resets historical run and page before subsequent reads', { timeout: 60000 }, async () => {
 const source = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ProspectingWorkspace} from '/app/components/ProspectingWorkspace.tsx'; createRoot(document.getElementById('root')).render(<ProspectingWorkspace initialSection="screen" />);`;
 const {server,origin,cacheDir}=await createFixture(source); const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href); let browser;
 try { browser=await chromium.launch({headless:true}); const page=await browser.newPage(); let created=false; const reads=[];
 const snapshot=id=>({campaign:{id,name:`任务${id}`,status:'active',requirements:'目标客户',keywords:[],candidates:[],selectedCandidateIds:[],reviewMode:'manual',minIntentScore:70,dailyLimit:10,maxCommentsPerVideo:30},campaigns:[{id,name:`任务${id}`,status:'active'}],leads:[],jobs:[],modelReady:false,discoveryRuns:[{id:'old',scheduledFor:'2026-11-08T01:00:00Z',status:'completed',newAccounts:0,newComments:0,newLeads:0,completedJobs:1,totalJobs:1}],leadPagination:{page:1,pageSize:30,total:60}});
 await page.route('**/api/prospecting**',async route=>{const request=route.request(); const url=new URL(request.url()); if(request.method()==='POST'){created=true;return route.fulfill({json:{snapshot:snapshot('b'),campaignId:'b'}});} if(created) reads.push(Object.fromEntries(url.searchParams)); return route.fulfill({json:snapshot(url.searchParams.get('campaignId')||'a')});});
 await page.goto(origin); await page.getByLabel('范围').selectOption('old'); await page.waitForFunction(()=>!document.querySelector('[aria-label=范围]').disabled); await page.getByRole('button',{name:'下一页'}).click(); await page.waitForFunction(()=>document.querySelector('.prospect-inbox-pagination').textContent.includes('第 2 页'));
 await page.getByRole('button',{name:'任务与采集',exact:true}).click(); await page.getByRole('button',{name:'新建任务',exact:true}).click(); await page.getByLabel('产品与目标客群').fill('新任务客户需求'); await page.getByRole('button',{name:'创建任务',exact:true}).click(); await page.waitForFunction(()=>document.querySelector('[aria-label=当前任务]')?.value==='b');
 await page.getByRole('button',{name:'关闭详情'}).click(); await page.waitForFunction(()=>document.querySelector('[aria-label=范围]')?.value===''); await page.waitForTimeout(4500); assert.equal(await page.getByLabel('范围').inputValue(),''); assert.match(await page.locator('.prospect-inbox-pagination').first().textContent(),/第 1 页/); assert.ok(reads.length>0); assert.ok(reads.every(read=>read.campaignId==='b' && read.leadPage==='1' && !read.runId));
 } finally {await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});
