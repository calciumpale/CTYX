import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {createSeed} from '../app/lib/seed.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import '/app/globals.css';import Workbench from '/app/components/Workbench.tsx';createRoot(document.getElementById('root')).render(<Workbench member={{accountId:'manager',username:'manager',displayName:'管理者',role:'manager'}} onLogout={async()=>{window.__loggedOut=true;}}/>);`;

test('knowledge drafts and accepted uploads guard inner tabs, global navigation and logout',{timeout:90000},async()=>{
 const cacheDir=await mkdtemp(path.join(tmpdir(),'knowledge-navigation-ui-'));
 const server=await createServer({root,configFile:false,logLevel:'error',cacheDir,resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react']},plugins:[react(),{
  name:'knowledge-navigation-fixture',resolveId(id){if(id==='/__knowledge-navigation.jsx')return path.join(root,'__knowledge-navigation.jsx');},load(id){if(id===path.join(root,'__knowledge-navigation.jsx'))return fixture;},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/',`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__knowledge-navigation.jsx"></script></body></html>`));});}
 }],server:{host:'127.0.0.1',port:0,hmr:false}});
 let browser,releaseUpload;
 try{
  await server.listen();
  const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const state=createSeed('2026-11-08T00:00:00Z');state.role='manager';
  const snapshot={libraries:[{id:'library',name:'共享资料',departmentId:'shared',version:1,documentCount:0}],documents:[],canManage:true,embeddingConfigured:false};
  let uploads=0;
  await page.route('**/api/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/api/workbench')return route.fulfill({json:state});
   if(pathname==='/api/knowledge-library'){
    if(route.request().method()==='GET')return route.fulfill({json:snapshot});
    const body=route.request().postDataJSON();
    if(body.action==='upload'){
     uploads++;await new Promise(resolve=>{releaseUpload=resolve;});
     const document={id:'doc',libraryId:'library',title:body.title,fileName:body.fileName,strategy:'flat',status:'pending',chunkCount:1,indexedCount:0,error:null,updatedAt:'2026-11-08T00:00:00Z',contentVersion:1,sourceAvailable:true};
     snapshot.documents=[document];return route.fulfill({json:{document}});
    }
   }
   return route.fulfill({json:{pendingCount:0}});
  });
  await page.goto(server.resolvedUrls.local[0]+'?view=knowledge');
  await page.getByRole('button',{name:'导入资料',exact:true}).click();
  await page.getByRole('button',{name:'粘贴文本',exact:true}).click();
  await page.getByLabel('资料标题',{exact:true}).fill('未提交资料');
  await page.getByLabel(/^正文/).fill('保留原始资料正文。');
  const confirm=page.locator('.confirmation-dialog');
  // Dispatch the actual navigation handlers while the import overlay owns focus.
  // These paths must remain guarded even when triggered outside a pointer click.
  for(const target of [page.getByRole('button',{name:'知识与方法',exact:true}),page.locator('.sidebar nav').getByRole('link',{name:'项目跟进',exact:true}),page.getByRole('button',{name:'退出登录',exact:true})]){
   await target.dispatchEvent('click');await confirm.waitFor({timeout:4000});
   await confirm.getByRole('button',{name:'继续编辑',exact:true}).click();await confirm.waitFor({state:'hidden'});
   assert.equal(await page.getByLabel(/^正文/).inputValue(),'保留原始资料正文。');
   assert.equal(new URL(page.url()).searchParams.get('view'),'knowledge');
   assert.equal(await page.evaluate(()=>Boolean(window.__loggedOut)),false);
  }
  await page.locator('.knowledge-dialog').getByRole('button',{name:'导入资料',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.knowledge-dialog button[type=submit]')?.disabled||[...document.querySelectorAll('.knowledge-dialog button')].some(x=>/正在导入/.test(x.textContent)));
  assert.equal(uploads,1);
  await page.getByRole('button',{name:'知识与方法',exact:true}).dispatchEvent('click');
  assert.equal(await confirm.count(),0);assert.equal(await page.locator('.knowledge-library-workspace,.knowledge-libraries').count()>0||await page.getByRole('button',{name:'资料库设置'}).count()>0,true);
  releaseUpload();releaseUpload=undefined;
  await page.locator('.knowledge-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(x=>x.textContent==='资料库设置'&&!x.disabled));
  await page.locator('.sidebar nav').getByRole('link',{name:'项目跟进',exact:true}).click();
  await page.waitForFunction(()=>new URL(location.href).searchParams.get('view')==='deals',{timeout:5000});assert.equal(await confirm.count(),0);assert.deepEqual(errors,[]);
 }finally{releaseUpload?.();await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});
