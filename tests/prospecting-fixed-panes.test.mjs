import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const root = fileURLToPath(new URL('../', import.meta.url));
// Real workspace/CSS, shell markup matching Workbench; all API traffic stays in this fixture.
const fixture = `import React from 'react'; import {createRoot} from 'react-dom/client';
import '/app/globals.css'; import '/app/components/admin-workspace.css';
import {ProspectingWorkspace} from '/app/components/ProspectingWorkspace.tsx';
createRoot(document.getElementById('root')).render(<div className="app-shell"><aside className="sidebar">主导航</aside><div className="workspace"><header className="topbar">营销工作台</header><main className="main-content"><ProspectingWorkspace initialSection="handoff" /></main></div><nav className="mobile-role-navigation"><button>获客</button></nav></div>);`;
async function createFixture(source) {
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

const conversation = index => ({id:`c${index}`, campaignId:'a', leadId:`l${index}`,recipientId:`r${index}`,nickname:`测试客户${index}`,mode:'human',status:'active',version:1,lastMessageAt:'2026-11-08T01:00:00Z',lastMessagePreview:'测试沟通记录',handoffReason:'客户要求人工跟进',updatedAt:'2026-11-08T01:00:00Z',memory:{needs:{},stage:'qualifying',contactCaptured:false,summary:''}});
const snapshot = {campaign:{id:'a',name:'测试任务',status:'active',requirements:'目标客群',keywords:[],candidates:[],selectedCandidateIds:[],reviewMode:'manual',minIntentScore:70,dailyLimit:10,maxCommentsPerVideo:30},campaigns:[{id:'a',name:'测试任务',status:'active'}],leads:[],jobs:[],modelReady:true,enabled:false,online:true,policy:{libraryIds:[],replyDailyLimit:30,conversationReplyLimit:12,replyHoursEnabled:false,workStart:'08:30',workEnd:'21:30'},libraries:[],conversations:Array.from({length:40},(_,i)=>conversation(i)),messages:Array.from({length:40},(_,i)=>({id:`m${i}`,conversationId:'c0',direction:'inbound',actor:'customer',text:`测试消息 ${i}：希望了解详情`,status:'received',createdAt:'2026-11-08T01:00:00Z'})),pool:[]};
for (const viewport of [{width:1440,height:900},{width:1280,height:560},{width:390,height:720}]) {
 test(`prospecting panes contain scroll at ${viewport.width}x${viewport.height}`, {timeout:60000}, async()=>{
  const {server,origin,cacheDir}=await createFixture(fixture); let browser;
  try {
   const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
   browser=await chromium.launch({headless:true}); const page=await browser.newPage({viewport});
   await page.route('**/api/**',route=>route.fulfill({json:snapshot}));
   await page.goto(origin); await page.locator('.prospect-conversation-item').first().waitFor();
   const listScroll=await page.locator('.prospect-conversation-items').evaluate(el=>{el.scrollTop=el.scrollHeight;return {max:el.scrollHeight-el.clientHeight,top:el.scrollTop,height:el.clientHeight}});
   assert.ok(listScroll.height>40 && listScroll.max>0 && listScroll.top>0,JSON.stringify(listScroll));
   await page.locator('.prospect-conversation-item').first().click();
   const bounds=await page.evaluate(()=>{
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}};
    return {body:document.documentElement.scrollHeight,viewport:innerHeight,sidebar:rect('.prospect-sidebar'),pane:rect('.prospect-content'),main:rect('.main-content'),width:document.documentElement.scrollWidth,viewportWidth:innerWidth};
   });
   assert.ok(bounds.body<=bounds.viewport+1,JSON.stringify(bounds));
   assert.ok(bounds.pane.bottom<=bounds.viewport+1,JSON.stringify(bounds));
   assert.ok(bounds.width<=bounds.viewportWidth+1,JSON.stringify(bounds));
   if(viewport.width>850) assert.equal(bounds.sidebar.height,bounds.pane.height);
   // Long transcripts scroll independently of the outer page.
   for(const selector of ['.prospect-chat-transcript']) {
    const scroll=await page.locator(selector).evaluate(el=>{el.scrollTop=0;const max=el.scrollHeight-el.clientHeight;el.scrollTop=max;return {max,top:el.scrollTop,height:el.clientHeight}});
    assert.ok(scroll.height>40,`${selector} needs a usable viewport: ${JSON.stringify(scroll)}`);
    assert.ok(scroll.max>0 && scroll.top>0,`${selector} must scroll internally: ${JSON.stringify(scroll)}`);
   }
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
   if(viewport.width>850) {
    const independent=await page.locator('.prospect-sidebar').evaluate(el=>{const nav=el.querySelector('nav');for(let i=0;i<30;i++)nav.append(nav.firstElementChild.cloneNode(true));el.scrollTop=el.scrollHeight;return {top:el.scrollTop,bottom:el.getBoundingClientRect().bottom}});
    assert.ok(independent.top>0); assert.ok(independent.bottom<=viewport.height);
   }
   await page.locator('.prospect-chat-composer textarea').fill('');
   await page.getByRole('link',{name:'获客任务',exact:true}).first().click();
   await page.getByRole('button',{name:'新建任务',exact:true}).click();
   await page.locator('.prospect-create').waitFor();
   assert.equal(await page.evaluate(() => document.activeElement.textContent), '新建获客任务');
   await page.getByText('筛选与发送设置', { exact: true }).click();
   await page.getByText('连接你的抖音账号', { exact: true }).click();
   const form=await page.locator('.prospect-content').evaluate(el=>{el.scrollTop=el.scrollHeight;return {top:el.scrollTop,bottom:el.getBoundingClientRect().bottom,body:document.documentElement.scrollHeight}});
   assert.ok(form.top>0,'long task form scrolls inside main pane'); assert.ok(form.bottom<=viewport.height); assert.ok(form.body<=viewport.height+1);
  } finally {await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
 });
}
