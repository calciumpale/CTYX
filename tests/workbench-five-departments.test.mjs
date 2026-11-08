import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {createSeed} from '../app/lib/seed.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import '/app/globals.css';import Workbench from '/app/components/Workbench.tsx';createRoot(document.getElementById('root')).render(<Workbench member={{accountId:'member-zs',username:'ZS',displayName:'ZS',role:'sales',salesId:'sales-1'}} onLogout={async()=>{}}/>);`;

test('full workbench opens converted projects after reload and guards material drafts across desktop/mobile navigation',{timeout:90000},async()=>{
 const cacheDir=await mkdtemp(path.join(tmpdir(),'five-departments-ui-'));
 const server=await createServer({root,configFile:false,logLevel:'error',cacheDir,resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react']},plugins:[react(),{
  name:'five-departments-fixture',resolveId(id){if(id==='/__five-departments.jsx')return path.join(root,'__five-departments.jsx');},load(id){if(id===path.join(root,'__five-departments.jsx'))return fixture;},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url?.split('?')[0]!=='/')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/',`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__five-departments.jsx"></script></body></html>`));});}
 }],server:{host:'127.0.0.1',port:0,hmr:false}});
 let browser;
 try{
  await server.listen();
  const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const state=createSeed('2026-11-08T00:00:00Z');state.role='sales';state.viewer={name:'ZS',team:'招商',salesId:'sales-1'};
  const deal={...state.deals[0],id:'converted-project',name:'人工核实企业',projectName:'公开来源项目',dataOrigin:'research',contact:'',summary:'公开来源，客户需求待核实',needs:[],notes:[],amount:0,health:0};
  state.deals=[];state.runs=[];
  let reads=0;
  await page.route('**/api/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/api/workbench'){reads++;return route.fulfill({json:{...state,revision:reads,deals:reads>1?[deal]:[]}});}
   if(pathname==='/api/web-prospects')return route.fulfill({json:{tasks:[],leads:[{id:'lead',taskId:'search',version:2,status:'qualified',projectId:deal.id,sourceUrl:'https://example.com/public',title:'人工核实企业公开资料',excerpt:'公开摘要',platform:'other',query:'餐饮',region:'嘉兴',regionMatch:'unverified',retrievedAt:'2026-11-08T00:00:00Z'}]}});
   if(pathname==='/api/marketing-materials')return route.fulfill({json:{tasks:[],availability:{presentation:true,image:false,video:false}}});
   return route.fulfill({json:{pendingCount:0}});
  });
  await page.goto(server.resolvedUrls.local[0]+'?view=prospecting&section=web');
  await page.getByRole('button',{name:'打开已建项目',exact:true}).waitFor();
  await page.screenshot({path:'.superpowers/sdd/2026-11-08-five-departments/artifacts/workbench-web-desktop.png'});
  await page.getByRole('button',{name:'打开已建项目',exact:true}).click();
  await page.locator('.cw-chat-title h2').waitFor();
  assert.equal(await page.locator('.cw-chat-title h2').innerText(),deal.name);
  assert.ok(reads>=2);
  assert.equal(new URL(page.url()).searchParams.get('deal'),deal.id);
  await page.locator('.sidebar nav').getByRole('link',{name:'AI营销素材',exact:true}).click();
  for(const label of ['目标受众','产品卖点','参考资料']){
    await page.getByLabel(label).fill('保留此输入');
    await page.locator('.sidebar nav').getByRole('link',{name:'项目跟进',exact:true}).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button',{name:'继续编辑',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal(await page.getByLabel(label).inputValue(),'保留此输入');
    await page.getByLabel(label).fill('');
  }
  await page.goto(server.resolvedUrls.local[0]+'?view=materials');
  await page.getByLabel('目标受众',{exact:true}).fill('清空要求后仍保留');
  await page.getByLabel('产品与生成要求').fill('尚未提交的产品介绍');
  await page.getByLabel('产品与生成要求').fill('');
  await page.locator('.sidebar nav').getByRole('link',{name:'项目跟进',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:'继续编辑',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await page.getByLabel('产品与生成要求').inputValue(),'');assert.equal(await page.getByLabel('目标受众',{exact:true}).inputValue(),'清空要求后仍保留');
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=1);
  const shortcuts=await page.locator('.mobile-role-navigation button').evaluateAll(buttons=>buttons.map(button=>({width:button.getBoundingClientRect().width,labelHeight:button.querySelector('span').getBoundingClientRect().height})));
  assert.ok(shortcuts.every(button=>button.width>=44&&button.labelHeight<=20),JSON.stringify(shortcuts));
  await page.screenshot({path:'.superpowers/sdd/2026-11-08-five-departments/artifacts/workbench-material-mobile.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});
