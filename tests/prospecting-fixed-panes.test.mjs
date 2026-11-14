import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createSeed } from '../app/lib/seed.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
// Real Workbench shell and CSS. All API traffic stays in this fixture.
const fixture = `import React from 'react'; import {createRoot} from 'react-dom/client';
import '/app/globals.css'; import Workbench from '/app/components/Workbench.tsx';
createRoot(document.getElementById('root')).render(<Workbench member={{accountId:'member-1',username:'ZS',displayName:'ZS',role:'sales',salesId:'sales-1'}} onLogout={async()=>{}}/>);`;
async function createFixture(source) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'conversation-ui-vite-'));
  const server = await createServer({
    resolve: { dedupe: ['react', 'react-dom'] }, cacheDir, optimizeDeps: {
      noDiscovery: true,
      include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'react-markdown', 'remark-gfm', 'fflate', 'xlsx'],
    },
    root, configFile: false, logLevel: 'error', plugins: [react(), {
      name: 'conversation-test-fixture',
      resolveId(id) { if (id === '/__conversation-fixture.jsx') return path.join(root, '__conversation-fixture.jsx'); },
      load(id) { if (id === path.join(root, '__conversation-fixture.jsx')) return source; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/') return next();
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

const conversation = index => ({id:`c${index}`, campaignId:'a', leadId:`l${index}`,recipientId:`r${index}`,nickname:`测试客户${index}`,mode:'human',status:'active',version:1,lastMessageAt:'2026-11-08T01:00:00Z',lastMessagePreview:'测试沟通记录',handoffReason:'客户要求人工跟进',updatedAt:'2026-11-08T01:00:00Z',memory:{needs:{},stage:'qualifying',contactCaptured:false,summary:''}});
const snapshot = {campaign:{id:'a',name:'测试任务',status:'active',requirements:'目标客群',keywords:[],candidates:[],selectedCandidateIds:[],reviewMode:'manual',minIntentScore:70,dailyLimit:10,maxCommentsPerVideo:30},campaigns:[{id:'a',name:'测试任务',status:'active'}],leads:[],jobs:[],device:{online:true,authenticated:true,accountId:'sender'},modelReady:true,enabled:false,online:true,policy:{libraryIds:[],replyDailyLimit:30,conversationReplyLimit:12,replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30'},libraries:[],conversations:Array.from({length:40},(_,i)=>conversation(i)),messages:Array.from({length:40},(_,i)=>({id:`m${i}`,conversationId:'c0',direction:'inbound',actor:'customer',text:`测试消息 ${i}：希望了解详情`,status:'received',createdAt:'2026-11-08T01:00:00Z'})),pool:[]};
for (const viewport of [{width:1440,height:900},{width:1280,height:560},{width:390,height:720}]) {
 test(`prospecting panes contain scroll at ${viewport.width}x${viewport.height}`, {timeout:60000}, async()=>{
  const {server,origin,cacheDir}=await createFixture(fixture); let browser;
  try {
   const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
   browser=await chromium.launch({headless:true}); const page=await browser.newPage({viewport});
   page.setDefaultTimeout(6000);
   const writes=[];
   const state=createSeed('2026-11-08T00:00:00Z');
   state.role='sales'; state.viewer={name:'ZS',team:'招商',salesId:'sales-1'};
   await page.route('**/api/**',route=>{
    const request=route.request();
    if(request.method()!=='GET'){writes.push(request.method());return route.abort();}
    const pathname=new URL(request.url()).pathname;
    return route.fulfill({json:pathname==='/api/workbench'?state:pathname==='/api/prospecting'?snapshot:{pendingCount:0}});
   });
   await page.goto(`${origin}/?view=prospecting&section=handoff`);
   const table=page.getByRole('table',{name:'客户会话',exact:true});
   const first=table.getByRole('row').filter({has:page.getByText('测试客户0',{exact:true})});
   const transcript=page.getByRole('log',{name:'测试客户0的聊天记录',exact:true});
   await first.waitFor();
   assert.equal(await transcript.count(),0);
   const listScroll=await table.evaluate(table=>{
    let element=table.parentElement;
    while(element&&element!==document.body&&!/auto|scroll/.test(getComputedStyle(element).overflowY))element=element.parentElement;
    if(!element||element===document.body)return null;
    element.scrollTop=element.scrollHeight;
    return {max:element.scrollHeight-element.clientHeight,top:element.scrollTop,height:element.clientHeight,bottom:element.getBoundingClientRect().bottom};
   });
   assert.ok(listScroll,'the conversation list needs an independent scroll container');
   assert.ok(listScroll.height>40 && listScroll.max>0 && listScroll.top>0,JSON.stringify(listScroll));
   assert.ok(listScroll.bottom<=viewport.height+1,JSON.stringify(listScroll));
   await first.getByText('测试客户0',{exact:true}).click();
   await transcript.waitFor();
   const bounds=await page.evaluate(()=>{
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}};
    return {body:document.documentElement.scrollHeight,viewport:innerHeight,pane:rect('.prospect-content'),width:document.documentElement.scrollWidth,viewportWidth:innerWidth};
   });
   assert.ok(bounds.body<=bounds.viewport+1,JSON.stringify(bounds));
   assert.ok(bounds.pane.bottom<=bounds.viewport+1,JSON.stringify(bounds));
   assert.ok(bounds.width<=bounds.viewportWidth+1,JSON.stringify(bounds));
   // Long transcripts scroll independently of the outer page.
   const scroll=await transcript.evaluate(el=>{el.scrollTop=0;const max=el.scrollHeight-el.clientHeight;el.scrollTop=max;return {max,top:el.scrollTop,height:el.clientHeight}});
   assert.ok(scroll.height>40,`transcript needs a usable viewport: ${JSON.stringify(scroll)}`);
   assert.ok(scroll.max>0 && scroll.top>0,`transcript must scroll internally: ${JSON.stringify(scroll)}`);
   await page.locator('.prospect-chat-composer textarea').scrollIntoViewIfNeeded();
   const composer=await page.locator('.prospect-chat-composer textarea').boundingBox();
   assert.ok(composer.y>=0 && composer.y+composer.height<=viewport.height-(viewport.width<=700?60:0),JSON.stringify(composer));
   const send=page.getByRole('button',{name:'发送回复',exact:true});
   await send.scrollIntoViewIfNeeded();
   const sendRect=await send.boundingBox();
   assert.ok(sendRect.y>=0 && sendRect.y+sendRect.height<=viewport.height-(viewport.width<=700?60:0),JSON.stringify(sendRect));
   if(process.env.PROSPECT_PANE_SCREENSHOTS) await page.screenshot({path:path.join(process.env.PROSPECT_PANE_SCREENSHOTS,`prospect-panes-${viewport.width}x${viewport.height}.png`)});
   await page.locator('.prospect-chat-composer textarea').fill('仅本地草稿');
   assert.equal(await page.evaluate(()=>window.scrollY),0);
   await page.locator('.prospect-chat-composer textarea').fill('');
   await page.getByRole('button',{name:'返回会话列表',exact:true}).click();
   await table.waitFor();
   await page.getByRole('button',{name:'任务与采集',exact:true}).click();
   await page.getByRole('button',{name:'新建任务',exact:true}).click();
   await page.locator('.prospect-create').waitFor();
   await page.waitForFunction(() => document.activeElement.matches('h2') && document.activeElement.textContent === '新建获客任务', null, {timeout:6000});
   await page.getByText('筛选与发送设置', { exact: true }).click();
   const connectionSetup=page.getByText('抖音账号 · 已连接', { exact: true });
   if(await connectionSetup.isVisible()) await connectionSetup.click();
   const form=await page.locator('.prospect-create').evaluate(element=>{
    while(element&&element!==document.body&&!/auto|scroll/.test(getComputedStyle(element).overflowY))element=element.parentElement;
    if(!element||element===document.body)return null;
    element.scrollTop=element.scrollHeight;
    return {top:element.scrollTop,bottom:element.getBoundingClientRect().bottom,body:document.documentElement.scrollHeight};
   });
   assert.ok(form,'the task form needs an independent scroll container');
   assert.ok(form.top>0,'long task form scrolls inside main pane'); assert.ok(form.bottom<=viewport.height); assert.ok(form.body<=viewport.height+1);
   assert.deepEqual(writes,[]);
  } finally {await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
 });
}
