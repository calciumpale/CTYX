import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/app/globals.css';
import {KnowledgeLibraries} from '/app/components/KnowledgeLibraries.tsx';
import {ApiConnectionSettings} from '/app/components/ApiConnectionSettings.tsx';
import MaterialConnectionSettings from '/app/components/MaterialConnectionSettings.tsx';
import WebProspecting from '/app/components/WebProspecting.tsx';
import {ProjectsView} from '/app/components/ProjectWorkspace.tsx';
import {createSeed} from '/app/lib/seed.ts';
const which = new URLSearchParams(location.search).get('module');
const seed = createSeed('2026-11-08T00:00:00Z');
const views = {
 knowledge: <KnowledgeLibraries notify={()=>{}}/>,
 settings: <><ApiConnectionSettings/><MaterialConnectionSettings/></>,
 web: <div style={{height:900}}><WebProspecting/></div>,
 projects: <ProjectsView state={seed} member={{role:'manager',salesId:'manager',displayName:'管理者'}} mutate={async()=>({state:seed})} notify={()=>{}}/>,
 types: <div style={{display:"grid",gap:8,maxWidth:300}}><input aria-label="text"/><input type="number"/><input type="date"/><input type="search"/><select><option>选项</option></select><textarea rows="4"/><input type="checkbox"/><input type="radio"/><input type="file"/><input type="range"/><input type="color"/></div>,
};
createRoot(document.getElementById('root')).render(<main style={{padding:16,minWidth:0}}>{views[which]}</main>);
`;

async function createFixture() {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'form-controls-ui-'));
  const entry = path.join(root, '__form-controls-fixture.jsx');
  const server = await createServer({root, configFile:false, logLevel:'error', cacheDir,
    resolve:{dedupe:['react','react-dom']}, optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react']},
    plugins:[react(), {name:'form-controls-fixture',
      resolveId(id){if(id==='/__form-controls-fixture.jsx') return entry;},
      load(id){if(id===entry)return fixture;},
      configureServer(server){server.middlewares.use(async(req,res,next)=>{
        if(!req.url?.startsWith('/?'))return next();
        res.setHeader('Content-Type','text/html');
        res.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__form-controls-fixture.jsx"></script></body></html>'));
      });},
    }], server:{host:'127.0.0.1',port:0,hmr:false},
  });
  await server.listen();
  return {server,cacheDir,origin:server.resolvedUrls.local[0].replace(/\/$/,'')};
}

test('knowledge settings and explicit preview/apply preserve old content on desktop/mobile', {timeout:120000}, async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
 const {server,cacheDir,origin}=await createFixture(); let browser;
 try {browser=await chromium.launch({headless:true});const page=await browser.newPage();const actions=[];
 const document={id:'doc',libraryId:'library',title:'旧资料',fileName:'old.txt',strategy:'flat',status:'pending',chunkCount:2,indexedCount:0,sourceAvailable:false,contentVersion:1};
 await page.route('**/api/knowledge-library',async route=>{const body=route.request().postDataJSON(); if(body)actions.push(body);await route.fulfill({json:body?.action==='previewChunking'?{preview:{totalChunks:1,samples:[{text:'精确原文'}]}}:body?.action==='beginRechunk'?{document,job:{id:'job',status:'error',error:'合成失败'}}:{libraries:[{id:'library',name:'测试知识库',documentCount:1,version:1}],documents:[document],canManage:true,embeddingConfigured:false}});});
 for(const width of [1280,390]){await page.setViewportSize({width,height:740});await page.goto(origin+'/?module=knowledge');await page.getByRole('button',{name:'切块设置 / 重新切块'}).click();await page.getByText('成功激活前，旧内容及检索仍可用。').waitFor();assert.equal(await page.getByRole('button',{name:'确认重新切块'}).isEnabled(),false);await page.locator('textarea').fill('精确原文');await page.getByRole('button',{name:'预览拟用切块'}).click();await page.getByText('预览结果（尚未生效）').waitFor();const heights=await page.locator('fieldset input, fieldset select').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));assert.ok(heights.every(height=>height===(width>850?36:44)),JSON.stringify(heights));await page.getByRole('button',{name:'确认重新切块'}).click();await page.getByRole('dialog').getByRole('alert').filter({hasText:'合成失败'}).waitFor();assert.equal(actions.at(-1).text,'精确原文');assert.equal(actions.at(-1).version,1);assert.ok(await page.getByText('旧内容及检索仍可用。',{exact:false}).count());}
 } finally {await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('multiple selection and drag share a bounded queue, pause safely and retry accepted uploads without duplicates',{timeout:90000},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
 const {server,cacheDir,origin}=await createFixture();let browser,release;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});
  const documents=new Map(),calls=[],errors=[];let active=0,maxActive=0,started=0,ready;
  const twoStarted=new Promise(resolve=>{ready=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const snapshot={libraries:[{id:'library',name:'测试资料',departmentId:'shared',documentCount:0,version:1}],documents:[],canManage:true,embeddingConfigured:true};
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/knowledge-library',async route=>{
   if(route.request().method()==='GET')return route.fulfill({json:snapshot});
   const body=route.request().postDataJSON();calls.push(body);assert.equal(body.action,'upload','unchecked indexing must stay off for captured rows');
   active++;maxActive=Math.max(maxActive,active);
   try{
    if(++started===2)ready();if(started<=2)await gate;
    let document=documents.get(body.requestId);
    if(!document){document={id:'doc-'+documents.size,libraryId:body.libraryId,title:body.title,fileName:body.fileName,strategy:body.config.strategy,status:'pending',chunkCount:1,indexedCount:0,error:null,updatedAt:'2026-11-08T00:00:00Z'};documents.set(body.requestId,document);}
    if(body.fileName==='第二份.txt'&&calls.filter(x=>x.fileName===body.fileName).length===1)return route.abort('failed');
    return route.fulfill({json:{document}});
   }finally{active--;}
  });
  await page.goto(origin+'/?module=knowledge');await page.getByRole('button',{name:'导入资料',exact:true}).click();
  const checkboxGeometry=await page.getByLabel('建立向量索引（关闭后使用全文检索）').evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}));
  assert.ok(checkboxGeometry.width<=24&&checkboxGeometry.height<=24,'index checkbox must retain compact native geometry: '+JSON.stringify(checkboxGeometry));
  await page.getByLabel('建立向量索引（关闭后使用全文检索）').uncheck();
  const picker=page.locator('.knowledge-dialog input[type=file]');assert.equal(await picker.getAttribute('multiple'),'');
  await picker.setInputFiles([{name:'第一份.txt',mimeType:'text/plain',buffer:Buffer.from('第一份资料保留原始正文。')},{name:'第二份.txt',mimeType:'text/plain',buffer:Buffer.from('第二份资料响应丢失仍只入库一次。')},{name:'不支持.exe',mimeType:'application/octet-stream',buffer:Buffer.from('invalid')}]);
  await page.getByLabel('切块大小',{exact:true}).fill('512');
  const dropped=await page.evaluateHandle(()=>{const d=new DataTransfer();d.items.add(new File(['拖拽资料原始正文。'],'第三份.txt',{type:'text/plain',lastModified:123}));return d;});
  await picker.locator('xpath=../..').dispatchEvent('drop',{dataTransfer:dropped});await dropped.dispose();
  const rows=page.locator('.knowledge-dialog li');assert.equal(await rows.count(),4);
  await page.getByRole('button',{name:'开始 / 继续导入',exact:true}).click();await twoStarted;
  await page.getByRole('button',{name:'停止后续导入（等待当前请求完成）',exact:true}).click();
  release();release=undefined;
  await page.getByRole('button',{name:'开始 / 继续导入',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(x=>x.textContent==='开始 / 继续导入'&&!x.disabled));
  assert.equal(calls.length,2);assert.equal(maxActive,2);
  await page.getByRole('button',{name:'开始 / 继续导入',exact:true}).click();
  await rows.filter({hasText:'第三份.txt'}).getByRole('button',{name:'移除此项',exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.knowledge-dialog li')].find(x=>x.textContent.includes('第三份.txt'))?.textContent.includes('已完成'));
  const second=rows.filter({hasText:'第二份.txt'});await second.getByRole('button',{name:'重试此项',exact:true}).click();
  await page.getByRole('button',{name:'开始 / 继续导入',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.knowledge-dialog li')].find(x=>x.textContent.includes('第二份.txt'))?.textContent.includes('已完成'));
  const retries=calls.filter(x=>x.fileName==='第二份.txt');assert.equal(retries.length,2);assert.equal(retries[0].requestId,retries[1].requestId);assert.equal(documents.size,3);
  assert.equal(calls.find(x=>x.fileName==='第一份.txt').config.chunkSize,750);assert.equal(calls.find(x=>x.fileName==='第三份.txt').config.chunkSize,512);
  await page.getByRole('button',{name:'清除已完成',exact:true}).click();assert.equal(await rows.count(),1);
  await rows.getByRole('button',{name:'移除此项',exact:true}).click();assert.equal(await rows.count(),0);
  await picker.setInputFiles({name:'后续批次.txt',mimeType:'text/plain',buffer:Buffer.from('同一页面可以继续下一批资料。')});
  await page.getByRole('button',{name:'开始 / 继续导入',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.knowledge-dialog li')].find(x=>x.textContent.includes('后续批次.txt'))?.textContent.includes('已完成'));
  assert.equal(documents.size,4);
  await page.setViewportSize({width:390,height:740});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
 }finally{release?.();await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('rechunk consumes sibling jobs, waits on leases, resumes errors and retires cancelled intents',{timeout:60000},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
 const {server,cacheDir,origin}=await createFixture();let browser;
 try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 const document={id:'doc',libraryId:'library',title:'旧资料',fileName:'old.txt',strategy:'flat',status:'pending',chunkCount:2,indexedCount:0,sourceAvailable:true,contentVersion:1};
 let job={id:'j',documentId:'doc',status:'indexing',chunkCount:33,indexedCount:0,error:null};let mode='progress',calls=0;const begins=[];
 await page.route('**/api/knowledge-library',async route=>{
 const body=route.request().postDataJSON();let json;
 if(!body)json={libraries:[{id:'library',name:'库',documentCount:1}],documents:[{...document,rechunkJob:job}],canManage:true,embeddingConfigured:false};
 else if(body.action==='continueRechunk'){calls++;if(mode==='progress')job={...job,indexedCount:Math.min(33,job.indexedCount+16),status:job.indexedCount>=32?'completed':'indexing'};else if(mode==='error')job={...job,status:'error',error:'竞争失败'};json={document,job};}
 else if(body.action==='cancelRechunk'){job={...job,status:'cancelled'};json={document,job};}
 else if(body.action==='previewChunking')json={preview:{totalChunks:33,samples:[]}};
 else if(body.action==='beginRechunk'){begins.push(body);job={...job,status:mode==='cancelled'?'cancelled':'indexing',indexedCount:0,error:null};json={document,job};}
 await route.fulfill({json});
 });
 await page.goto(origin+'/?module=knowledge');await page.getByRole('button',{name:'继续重新切块',exact:true}).click();
 await page.waitForFunction(()=>!document.body.textContent.includes('继续重新切块'));assert.equal(calls,3);
 mode='waiting';job={...job,status:'ready',indexedCount:0};await page.reload();await page.getByRole('button',{name:'继续重新切块',exact:true}).click();
 await page.getByText('任务暂未推进').waitFor();assert.equal(calls,4);assert.ok(await page.getByRole('button',{name:'继续重新切块',exact:true}).isEnabled());
 mode='error';await page.getByRole('button',{name:'继续重新切块',exact:true}).click();await page.getByRole('alert').filter({hasText:'竞争失败'}).first().waitFor();
 mode='waiting';await page.getByRole('button',{name:'切块设置 / 重新切块'}).click();await page.getByRole('button',{name:'预览拟用切块'}).click();await page.getByRole('button',{name:'确认重新切块'}).click();
 await page.getByText('任务暂未推进').first().waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.getByRole('button',{name:'取消暂存任务'}).click();await page.waitForFunction(()=>!document.body.textContent.includes('取消暂存任务'));
 await page.getByRole('button',{name:'切块设置 / 重新切块'}).click();await page.getByRole('button',{name:'预览拟用切块'}).click();await page.getByRole('button',{name:'确认重新切块'}).click();await page.getByText('任务暂未推进').first().waitFor();
 assert.equal(begins.length,2);assert.notEqual(begins[0].requestId,begins[1].requestId);
 mode='cancelled';await page.getByRole('button',{name:'确认重新切块'}).click();await page.getByRole('dialog').getByRole('alert').filter({hasText:'任务已取消或被替代'}).waitFor();assert.equal(begins[1].requestId,begins[2].requestId);
 mode='waiting';await page.getByRole('button',{name:'确认重新切块'}).click();await page.getByText('任务暂未推进').first().waitFor();assert.notEqual(begins[2].requestId,begins[3].requestId);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('pause during accepted begin survives its response and only an explicit resume starts batches',{timeout:60000},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
 const {server,cacheDir,origin}=await createFixture();let browser,releaseBegin;
 try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 const document={id:'doc',libraryId:'library',title:'旧资料',fileName:'old.txt',strategy:'flat',status:'pending',chunkCount:2,indexedCount:0,sourceAvailable:true,contentVersion:1};
 let job={id:'accepted-job',documentId:'doc',status:'indexing',chunkCount:1000,indexedCount:0,error:null};let continues=0,begins=0;
 let beginEntered;const entered=new Promise(resolve=>{beginEntered=resolve;});const beginGate=new Promise(resolve=>{releaseBegin=resolve;});
 await page.route('**/api/knowledge-library',async route=>{
 const body=route.request().postDataJSON();let json;
 if(!body)json={libraries:[{id:'library',name:'库',documentCount:1}],documents:[document],canManage:true,embeddingConfigured:true};
 else if(body.action==='previewChunking')json={preview:{totalChunks:1000,samples:[]}};
 else if(body.action==='beginRechunk'){begins++;beginEntered();await beginGate;json={document,job};}
 else if(body.action==='continueRechunk'){assert.equal(body.jobId,'accepted-job');continues++;job={...job,indexedCount:job.indexedCount+16};json={document,job};}
 await route.fulfill({json});
 });
 await page.goto(origin+'/?module=knowledge');await page.getByRole('button',{name:'切块设置 / 重新切块'}).click();
 await page.getByRole('button',{name:'预览拟用切块'}).click();await page.getByRole('button',{name:'确认重新切块'}).click();await entered;
 await page.getByRole('button',{name:'暂停后续批次（等待当前请求完成）',exact:true}).click();releaseBegin();
 await page.getByText('已暂停后续批次，可继续重新切块。已接受的请求仍可能完成。',{exact:true}).waitFor();
 assert.equal(begins,1);assert.equal(continues,0);assert.equal(job.status,'indexing');
 await page.getByRole('dialog').getByText('重新切块：indexing · 0 / 1000',{exact:true}).waitFor();
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 const resume=page.getByRole('button',{name:'继续重新切块',exact:true});await resume.waitFor();assert.ok(await resume.isEnabled());assert.equal(continues,0);
 await resume.click();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='继续重新切块'&&!button.disabled));
 assert.equal(continues,8);assert.equal(begins,1);await page.getByText('重新切块：indexing · 128 / 1000 · 旧内容仍可用',{exact:true}).waitFor();
 }finally{releaseBegin?.();await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
