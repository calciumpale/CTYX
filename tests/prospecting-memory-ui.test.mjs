import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultPolicy = () => ({ libraryIds: [], replyDailyLimit: 30, conversationReplyLimit: 12, replyHoursEnabled: false, workStart: '08:30', workEnd: '21:30' });
const fixture = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProspectingConversations } from '/app/components/ProspectingConversations.tsx';
import '/app/globals.css';
import '/app/components/prospecting-workspace.css';
function Fixture() {
  const [campaignId, setCampaign] = useState('campaign-a');
  const [blocked, setBlocked] = useState(false);
  useEffect(() => { window.__chatFixture = { setCampaign, setBlocked }; }, []);
  return <main className="prospect-workspace" style={{ display: 'block', maxWidth: 1200, margin: 'auto', padding: 16 }}><ProspectingConversations key={campaignId} campaignId={campaignId} active view="chat" blocked={blocked} paused={false} modelReady assistantOnline sendingAvailable resetKey={0} onViewChange={() => {}} onDirtyChange={dirty => { window.__chatDirty = dirty; }} onBusyChange={() => {}} /></main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function createConversationFixture(source = fixture) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'conversation-ui-vite-'));
  const server = await createServer({
    resolve: { dedupe: ['react', 'react-dom'] }, cacheDir, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
    root, configFile: false, logLevel: 'error', plugins: [react(), {
      name: 'conversation-test-fixture',
      resolveId(id) { if (id === '/__memory-fixture.jsx') return path.join(root, '__memory-fixture.jsx'); },
      load(id) { if (id === path.join(root, '__memory-fixture.jsx')) return source; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== '/') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__memory-fixture.jsx"></script></body></html>'));
        });
      },
    }], server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  return { server, origin, cacheDir };
}

test('task memory keeps correction drafts across polling and conflict, preserves takeover when switching tasks', { timeout: 60000 }, async () => {
  const { chromium } = await import(pathToFileURL(path.join(root, 'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const { server, origin, cacheDir } = await createConversationFixture();
  const posts = []; let reject = true; let writable = true; let version = 1; let campaign = 'campaign-a';
  const fact = (id, key, value, status = 'confirmed') => ({id, key, value, status, sourceMessageId:'source-1', sourceText:'预算每月八千，不要转让费', actor:'customer', sourceAt:'2026-11-08T08:00:00Z',updatedAt:'2026-11-08T08:00:00Z'});
  const facts = [fact('budget','budget','8000 元/月'), fact('constraint','constraint','不要转让费'),fact('old','budget','5000 元/月','superseded'),fact('visit','next_step','周六想看铺','tentative')];
  const snapshot = () => ({enabled:true,online:true,policy:defaultPolicy(),memoryTasks:[{id:'campaign-a',name:'任务 A'},{id:'campaign-b',name:'任务 B'}],conversations:[{id:'c1',campaignId:'campaign-a',nickname:'隔离测试客户',mode:'human',status:'active',version:7,profileUrl:'',memoryEditable:writable,taskMemory:{sessionId:'s1',campaignId:'campaign-a',activeCampaignId:campaign,activeCampaignName:campaign === 'campaign-a' ? '任务 A' : '任务 B',isActive:campaign === 'campaign-a',sessionVersion:version,bindingVersion:3,ready:true,state:{schemaVersion:2,facts,events:[{id:'question',type:'customer_question',sourceMessageId:'source-1',sourceText:'是否有一楼铺位？',actor:'customer',sourceAt:'2026-11-08T08:00:00Z',updatedAt:'2026-11-08T08:00:00Z'},{id:'resolved-question',type:'customer_question',status:'resolved',resolvedBy:'answer-1',sourceMessageId:'source-1',sourceText:'停车怎么收费？',actor:'customer',sourceAt:'2026-11-08T08:00:00Z',updatedAt:'2026-11-08T08:00:00Z'}],ignoredSourceIds:[],sourceWatermark:1,summary:'已确认预算，待核实铺位',updatedAt:'2026-11-08T08:00:00Z',contact:{captured:false,declined:true,submittedInvites:1,legacyInvites:1,pendingInvites:1,uncertainInvites:1}}}}],messages:[{id:'source-1',conversationId:'c1',direction:'inbound',actor:'customer',text:'预算每月八千，不要转让费',status:'received',createdAt:'2026-11-08T08:00:00Z'}],pool:[]});
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext({viewport:{width:1280,height:1000}, serviceWorkers:'block'});
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); if (url.origin !== origin) return route.abort();
      if (url.pathname !== '/api/prospecting') return route.continue();
      if (route.request().method() === 'GET') return route.fulfill({json:snapshot()});
      const payload = route.request().postDataJSON(); posts.push(payload);
      if (reject) return route.fulfill({status:409,json:{error:'记忆版本冲突，请刷新后重试。'}});
      if (payload.action === 'chatSwitchTask') campaign = payload.targetCampaignId;
      else if (payload.operation === 'correct') { facts[0].value = payload.value; version++; }
      else if (payload.operation === 'retract') {facts.find(f => f.id === payload.factId).status = 'retracted'; version++;}
      else if (payload.operation === 'ignore') {facts[1].status='ignored'; version++;}
      return route.fulfill({json:{message:'已保存',chat:snapshot()}});
    });
    const page = await context.newPage(); await page.goto(origin);
    const memory = page.locator('.prospect-memory');
    await memory.getByText('本任务记忆', {exact:true}).waitFor({timeout:8000});
    await memory.locator(':scope > summary').click();
    await memory.getByText('8000 元/月', {exact:true}).waitFor();
    await memory.getByText('不要转让费', {exact:true}).waitFor();
    await memory.getByText('是否有一楼铺位？', {exact:true}).waitFor();
    const pendingQuestions = memory.getByRole('region',{name:'未解决问题与待核实事项'});
    await pendingQuestions.getByText('待核实问题',{exact:true}).waitFor({timeout:3000});
    assert.equal(await pendingQuestions.getByText('停车怎么收费？',{exact:true}).count(),0,'Resolved questions must leave the unresolved group');
    assert.match(await memory.textContent(), /邀请已提交 1 次/);
    assert.match(await memory.textContent(), /待核对 1 次/);
    assert.doesNotMatch(await memory.textContent(), /已送达/);
    await memory.locator('.prospect-memory-fact').filter({has: page.getByText('8000 元/月', {exact:true})}).locator('.prospect-memory-source > summary').click();
    await memory.getByRole('button',{name:'查看预算来源'}).click();
    assert.equal(await page.locator('#prospect-message-source-1').evaluate(el => document.activeElement === el), true);
    await memory.getByRole('button',{name:'纠正预算', exact:true}).click();
    assert.equal(await memory.getByLabel('纠正后的预算').evaluate(el => document.activeElement === el),true,'Correction opens at the editable field');
    await memory.getByLabel('纠正后的预算').fill('9000 元/月');
    await page.waitForFunction(() => window.__chatDirty === true);
    await page.waitForResponse(r => r.url().includes('/api/prospecting?') && r.request().method() === 'GET');
    assert.equal(await memory.getByLabel('纠正后的预算').inputValue(),'9000 元/月');
    await memory.getByRole('button',{name:'保存纠正'}).click();
    await page.getByText('记忆版本冲突，请刷新后重试。',{exact:true}).waitFor();
    assert.equal(await memory.getByLabel('纠正后的预算').inputValue(),'9000 元/月');
    version = 2;
    await page.waitForResponse(r => r.url().includes('/api/prospecting?') && r.request().method() === 'GET');
    await memory.getByRole('button',{name:'刷新版本，保留草稿'}).waitFor();
    assert.equal(await memory.getByRole('button',{name:'保存纠正'}).isDisabled(), true);
    assert.equal(await memory.getByLabel('纠正后的预算').inputValue(),'9000 元/月');
    await memory.getByRole('button',{name:'刷新版本，保留草稿'}).click();
    reject = false;
    await memory.getByRole('button',{name:'保存纠正'}).click();
    await memory.getByText('9000 元/月',{exact:true}).waitFor();
    await page.waitForFunction(() => window.__chatDirty === false);
    assert.deepEqual(posts[0],{action:'chatMemoryEdit',campaignId:'campaign-a',conversationId:'c1',sessionVersion:1,bindingVersion:3,factId:'budget',operation:'correct',value:'9000 元/月'});
    await page.evaluate(() => window.__chatFixture.setBlocked(true));
    assert.equal(await memory.getByRole('button',{name:'忽略附加条件'}).isDisabled(), true);
    await page.evaluate(() => window.__chatFixture.setBlocked(false));
    writable = false;
    await page.waitForResponse(r => r.url().includes('/api/prospecting?') && r.request().method() === 'GET');
    await memory.getByText('只读记忆，请联系任务负责人纠正。').waitFor();
    assert.equal(await memory.getByRole('button',{name:'忽略附加条件'}).isDisabled(), true);
    writable = true;
    await page.waitForResponse(r => r.url().includes('/api/prospecting?') && r.request().method() === 'GET');
    await memory.getByRole('button',{name:'标记预算不再适用'}).click();
    await memory.getByRole('button',{name:'确认不再适用'}).waitFor();
    await memory.getByRole('button',{name:'取消编辑'}).click();
    await memory.getByRole('button',{name:'忽略附加条件'}).click();
    await memory.getByRole('button',{name:'确认忽略'}).click();
    await memory.getByRole('button',{name:'标记下一步不再适用'}).click();
    await memory.getByRole('button',{name:'确认不再适用'}).click();
    await memory.getByRole('button',{name:'标记下一步不再适用'}).waitFor({state:'hidden'});
    assert.equal(posts.at(-1).operation, 'retract');
    await memory.getByLabel('切换接待任务').selectOption('campaign-b');
    await memory.getByRole('button',{name:'确认切换任务'}).click();
    await memory.getByText('当前自动接待任务：任务 B',{exact:true}).waitFor();
    assert.equal(posts.some(p => p.action === 'chatResume'), false);
    assert.deepEqual(posts.at(-1),{action:'chatSwitchTask',campaignId:'campaign-a',conversationId:'c1',targetCampaignId:'campaign-b',version:7,bindingVersion:3});
    await memory.locator('.prospect-memory-history > summary').click();
    await memory.getByText('5000 元/月',{exact:true}).waitFor();
    await memory.getByText('已被替代',{exact:true}).waitFor();
    await memory.locator('.prospect-memory-body').evaluate(el => { el.scrollTop=0; });
    if (process.env.PROSPECT_MEMORY_CAPTURE_DIR) { await mkdir(process.env.PROSPECT_MEMORY_CAPTURE_DIR,{recursive:true}); await page.screenshot({path:path.join(process.env.PROSPECT_MEMORY_CAPTURE_DIR,'memory-desktop.png'),fullPage:true}); }
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:/隔离测试客户/}).click();
    assert.ok((await memory.getByRole('button',{name:'纠正预算',exact:true}).boundingBox()).height >= 44);
    assert.equal(await memory.getByRole('button',{name:'纠正预算',exact:true}).isDisabled(),true,'Inactive tasks cannot edit memory');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    if (process.env.PROSPECT_MEMORY_CAPTURE_DIR) await page.screenshot({path:path.join(process.env.PROSPECT_MEMORY_CAPTURE_DIR,'memory-mobile.png'),fullPage:true});
  } finally {await browser?.close(); await server.close(); await rm(cacheDir,{recursive:true,force:true});}
});

const workspaceFixture = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {ProspectingWorkspace} from '/app/components/ProspectingWorkspace.tsx';
import '/app/globals.css'; import '/app/components/admin-workspace.css';
createRoot(document.getElementById('root')).render(<div className="app-shell"><aside className="sidebar">主导航</aside><div className="workspace"><header className="topbar">营销工作台</header><main className="main-content"><ProspectingWorkspace initialSection="handoff" /></main></div></div>);`;

test('real workspace navigates after memory task switch releases saving guard and retains human control', {timeout:30000}, async () => {
  const {server,origin,cacheDir} = await createConversationFixture(workspaceFixture);
  const {chromium} = await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  const tasks = [{id:'a',name:'任务 A',status:'active'},{id:'b',name:'任务 B',status:'active'}];
  let bound = 'a'; const posts = []; let browser;
  const snapshot = campaignId => ({campaign:{...tasks.find(task=>task.id===campaignId),requirements:'测试需求',keywords:[],candidates:[],selectedCandidateIds:[],reviewMode:'manual',minIntentScore:70,dailyLimit:10,maxCommentsPerVideo:30},campaigns:tasks,leads:[],jobs:[],modelReady:true,enabled:true,online:true,policy:defaultPolicy(),libraries:[],memoryTasks:tasks,conversations:[{id:'c1',campaignId,nickname:'切换回归客户',mode:'human',status:'active',version:7,handoffReason:'已由销售接管',profileUrl:'',taskMemory:{sessionId:'s-'+campaignId,campaignId,activeCampaignId:bound,activeCampaignName:tasks.find(task=>task.id===bound).name,isActive:bound===campaignId,ready:true,sessionVersion:1,bindingVersion:3,state:{schemaVersion:2,facts:[],events:[],ignoredSourceIds:[],sourceWatermark:1,summary:'',updatedAt:'2026-11-08T08:00:00Z',contact:{captured:false,declined:false,submittedInvites:0,legacyInvites:0,pendingInvites:0,uncertainInvites:0}}}}],messages:[],pool:[]});
  try {
    browser = await chromium.launch({headless:true}); const page = await browser.newPage({viewport:{width:1280,height:1000}});
    await page.route('**/*', async route=>{
      const url = new URL(route.request().url()); if(url.origin !== origin) return route.abort();
      if(url.pathname !== '/api/prospecting') return route.continue();
      if(route.request().method()==='GET') return route.fulfill({json:snapshot(url.searchParams.get('campaignId') || 'a')});
      const payload=route.request().postDataJSON(); posts.push(payload);
      if(payload.action==='chatSwitchTask') bound=payload.targetCampaignId;
      return route.fulfill({json:{message:'任务已切换',chat:snapshot(bound)}});
    });
    await page.goto(origin);
    await page.locator('.prospect-memory > summary').click();
    await page.getByLabel('切换接待任务',{exact:true}).selectOption('b');
    await page.getByRole('button',{name:'确认切换任务'}).click();
    await page.waitForFunction(()=>document.querySelector('.prospect-task-picker select')?.value === 'b',{},{timeout:4000});
    await page.locator('.prospect-memory > summary').click();
    await page.getByText('当前自动接待任务：任务 B',{exact:true}).waitFor();
    await page.getByRole('button',{name:'交还 AI 助手',exact:true}).waitFor();
    assert.equal(await page.getByText('人工接管中，AI 助手已停止回复此会话',{exact:true}).count(),1);
    assert.equal(await page.getByText('当前操作正在保存，请等待完成后再离开。',{exact:true}).count(),0);
    assert.deepEqual(posts.map(post=>post.action),['chatSwitchTask']);
    // A subsequent real poll must keep the parent-selected target instead of reverting to A.
    await page.waitForResponse(response=>response.url().includes('mode=chat') && response.url().includes('campaignId=b'));
    assert.equal(await page.getByLabel('当前任务',{exact:true}).inputValue(),'b');
    await page.locator('.prospect-chat-composer textarea').fill('未发送的本地草稿');
    await page.getByLabel('当前任务',{exact:true}).selectOption('a');
    await page.getByRole('dialog').getByText('有尚未保存的获客内容',{exact:true}).waitFor();
    await page.getByRole('button',{name:'继续编辑',exact:true}).click();
    assert.equal(await page.getByLabel('当前任务',{exact:true}).inputValue(),'b');
    assert.equal(await page.locator('.prospect-chat-composer textarea').inputValue(),'未发送的本地草稿','Successful navigation must preserve future dirty-content guards');
    assert.deepEqual(posts.map(post=>post.action),['chatSwitchTask']);
  } finally {await browser?.close(); await server.close(); await rm(cacheDir,{recursive:true,force:true});}
});
