import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));

const digitalHumanFixture="import React,{useEffect,useState} from 'react';export default function DigitalHumanWorkspace({onBusyChange,onDirtyChange}){const [value,setValue]=useState(''),[busy,setBusy]=useState(false);useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);useEffect(()=>{onDirtyChange?.(!!value.trim());return()=>onDirtyChange?.(false);},[value,onDirtyChange]);return <div className='digital-human-workspace'><label>数字人测试草稿<input value={value} onChange={e=>setValue(e.target.value)}/></label><button onClick={()=>setBusy(!busy)}>{busy?'结束数字人测试请求':'开始数字人测试请求'}</button></div>;}";

const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import MarketingMaterials from '/app/components/MarketingMaterials.tsx';import MaterialConnectionSettings from '/app/components/MaterialConnectionSettings.tsx';import '/app/form-controls.css';createRoot(document.getElementById('root')).render(<><div style={{height:'100vh'}}><MarketingMaterials notify={()=>{}}/></div><MaterialConnectionSettings/></>);`;
async function createFixture(source) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'material-ui-vite-'));
  const server = await createServer({
    resolve: { dedupe: ['react', 'react-dom'] }, cacheDir, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
    root, configFile: false, logLevel: 'error', plugins: [react(), {
      name: 'material-test-fixture',
      // This child boundary must resolve before Vite's existing-file resolver.
      enforce: 'pre',
      resolveId(id,importer) { if(id===path.join(root,'app/components/DigitalHumanWorkspace.tsx')||id==='/app/components/DigitalHumanWorkspace.tsx'||id==='./DigitalHumanWorkspace'&&importer?.endsWith('/app/components/MarketingMaterials.tsx'))return path.join(root,'__digital-human-fixture.jsx');if (id === '/__material-fixture.jsx') return path.join(root, '__material-fixture.jsx'); },
      load(id) { if(id===path.join(root,'__digital-human-fixture.jsx'))return digitalHumanFixture;if (id === path.join(root, '__material-fixture.jsx')) return source; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== '/') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__material-fixture.jsx"></script></body></html>'));
        });
      },
    }], server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  return { server, origin, cacheDir };
}


test('unified material entries retain image/video drafts, remove deck tools and fit mobile', {timeout:60000},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture(fixture);let browser;
 try {browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let connectionWrites=0;
  const tasks=[{id:'old-deck',requestId:'old',version:2,status:'completed',input:{kind:'presentation',prompt:'历史演示稿'},progress:100,files:[],slides:[],createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z',pollAt:0}];
  await page.route('**/api/marketing-materials',route=>route.fulfill({json:{tasks,availability:{presentation:true,image:false,video:false}}}));await page.route('**/api/material-connection',route=>{if(route.request().method()==='POST')connectionWrites++;return route.fulfill({json:{connection:{kind:'apimart',configured:false,hasSecret:false,enabled:false,version:0,imageModel:'gpt-image-1-official',storageReady:true},message:'已保存'}});});
  await page.goto(origin);await page.getByLabel('产品与生成要求').waitFor();
  assert.equal(await page.getByRole('heading',{name:'AI营销素材',exact:true}).count(),1);
  assert.deepEqual(await page.getByRole('tab').allTextContents(),['图文生成','数字人']);
  assert.equal(await page.getByRole('tab',{name:'产品演示稿'}).count(),0);assert.equal(await page.getByText('历史演示稿',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'导出可编辑 PPTX'}).count(),0);
  assert.equal(await page.getByLabel('输出类型',{exact:true}).inputValue(),'image');
  await page.getByLabel('产品与生成要求').fill('保留的图片输入');assert.equal(await page.getByRole('button',{name:'生成营销图片'}).isDisabled(),true);
  await page.getByLabel('输出类型',{exact:true}).selectOption('video');await page.getByLabel('产品与生成要求').fill('保留的视频输入');await page.getByLabel('时长（秒）',{exact:true}).fill('10');
  await page.getByRole('tab',{name:'数字人',exact:true}).click();await page.getByLabel('数字人测试草稿').fill('保留的数字人输入');await page.getByRole('tab',{name:'图文生成',exact:true}).click();assert.equal(await page.getByLabel('产品与生成要求').inputValue(),'保留的视频输入');assert.equal(await page.getByLabel('时长（秒）',{exact:true}).inputValue(),'10');
  await page.getByLabel('输出类型',{exact:true}).selectOption('image');assert.equal(await page.getByLabel('产品与生成要求').inputValue(),'保留的图片输入');await page.getByRole('tab',{name:'数字人',exact:true}).click();assert.equal(await page.getByLabel('数字人测试草稿').inputValue(),'保留的数字人输入');await page.getByRole('tab',{name:'图文生成',exact:true}).click();await page.screenshot({path:'.superpowers/sdd/2026-11-08-five-departments/artifacts/material-desktop.png',fullPage:true});
  const fieldHeights=()=>page.locator('.material-workspace input:not([type=checkbox]),.material-workspace select,.material-connection input:not([type=checkbox]),.material-connection select').evaluateAll(fields=>[...new Set(fields.map(field=>Math.round(field.getBoundingClientRect().height)).filter(Boolean))]);assert.deepEqual(await fieldHeights(),[36]);await page.getByLabel(/API Key/).fill('test-key-not-live');await page.getByRole('button',{name:'保存连接',exact:true}).click();assert.equal(connectionWrites,1);await page.waitForFunction(()=>document.querySelector('input[type=password]').value==='');assert.equal(await page.getByLabel(/API Key/).inputValue(),'');await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.superpowers/sdd/2026-11-08-five-departments/artifacts/material-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(await fieldHeights(),[44]);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('pending generation locks type and entry changes while terminal attempts explicitly renew identity', {timeout:60000},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture(fixture);let browser;
 try{browser=await chromium.launch({headless:true});const page=await browser.newPage();let release;let started;const waiting=new Promise(r=>{started=r;});const held=new Promise(r=>{release=r;});const ids=[];let status='completed';let first=true;
  await page.route('**/api/material-connection',r=>r.fulfill({json:{connection:{version:0,imageModel:'gpt-image-1-official',enabled:false,storageReady:true}}}));
  await page.route('**/api/marketing-materials',async route=>{if(route.request().method()==='GET')return route.fulfill({json:{tasks:[],availability:{presentation:true,image:true,video:true}}});const body=route.request().postDataJSON();assert.equal(body.action,'generate');ids.push(body.requestId);if(first){first=false;started();await held;}return route.fulfill({json:{task:{id:'image-'+ids.length,requestId:body.requestId,version:1,status,input:body.input,progress:100,files:[],slides:[],createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z',pollAt:0}}});});
  await page.goto(origin);await page.getByLabel('产品与生成要求').fill('产品');await page.getByRole('button',{name:'生成营销图片',exact:true}).click();await waiting;
  assert.equal(await page.getByLabel('输出类型',{exact:true}).isDisabled(),true);assert.equal(await page.getByLabel('产品与生成要求').isDisabled(),true);assert.equal(await page.getByRole('tab',{name:'数字人',exact:true}).isDisabled(),true);
  await page.locator('.material-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(ids.length,1);release();
  await page.getByRole('button',{name:'新建同内容任务',exact:true}).waitFor();await page.getByRole('button',{name:'新建同内容任务',exact:true}).click();assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);status='failed';await page.getByRole('button',{name:'新建同内容任务',exact:true}).click();await page.getByRole('button',{name:'新建同内容任务',exact:true}).click();assert.notEqual(ids[2],ids[3]);
  status='submission_unknown';await page.getByRole('button',{name:'新建同内容任务',exact:true}).click();const unknownId=ids.at(-1);await page.getByRole('button',{name:'新建同内容任务',exact:true}).waitFor({state:'hidden'});assert.equal(await page.getByRole('button',{name:'新建同内容任务',exact:true}).count(),0);await page.getByRole('button',{name:'生成营销图片',exact:true}).click();assert.equal(ids.at(-1),unknownId);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('switching image and video preserves each accepted submission identity',{timeout:60000},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture(fixture);let browser;
 try{browser=await chromium.launch({headless:true});const page=await browser.newPage();const actions=[];
  await page.route('**/api/material-connection',route=>route.fulfill({json:{connection:{version:0,imageModel:'gpt-image-1-official',enabled:false,storageReady:true}}}));
  await page.route('**/api/marketing-materials',route=>{if(route.request().method()==='GET')return route.fulfill({json:{tasks:[],availability:{image:true,video:true,presentation:false}}});const body=route.request().postDataJSON();actions.push(body);return route.fulfill({json:{task:{id:'accepted-'+body.input.kind,requestId:body.requestId,version:1,status:'queued',input:body.input,progress:0,files:[],slides:[],createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z',pollAt:0}}});});
  await page.goto(origin);await page.getByLabel('产品与生成要求').fill('同一产品');await page.getByRole('button',{name:'生成营销图片',exact:true}).click();await page.getByRole('button',{name:'生成营销图片',exact:true}).waitFor();
  await page.getByLabel('输出类型',{exact:true}).selectOption('video');await page.getByLabel('产品与生成要求').fill('同一产品');await page.getByRole('button',{name:'生成营销视频',exact:true}).click();await page.getByRole('button',{name:'生成营销视频',exact:true}).waitFor();
  await page.getByLabel('输出类型',{exact:true}).selectOption('image');await page.getByRole('button',{name:'生成营销图片',exact:true}).click();await page.getByRole('button',{name:'生成营销图片',exact:true}).waitFor();
  assert.equal(actions.length,3);assert.notEqual(actions[0].requestId,actions[1].requestId);assert.equal(actions[0].requestId,actions[2].requestId);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('all material draft inputs trigger the parent leave guard and defaults normalize cleanly', {timeout:60000},async()=>{
 const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import MarketingMaterials from '/app/components/MarketingMaterials.tsx';function Parent(){const [dirty,setDirty]=useState(false),[left,setLeft]=useState(false),[warning,setWarning]=useState(false);return <><button onClick={()=>dirty?setWarning(true):setLeft(true)}>离开素材</button>{warning&&<p role="alert">存在未保存草稿</p>}{left?<p>已离开</p>:<MarketingMaterials notify={()=>{}} onDirtyChange={setDirty}/>}</>};createRoot(document.getElementById('root')).render(<Parent/>);`;
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture(source);let browser;try{browser=await chromium.launch({headless:true});const page=await browser.newPage();let writes=0;await page.route('**/api/marketing-materials',route=>{if(route.request().method()==='POST')writes++;return route.fulfill({json:{tasks:[],availability:{presentation:true,image:true,video:true}}});});
 for(const label of ['目标受众','产品卖点','参考资料']){await page.goto(origin);await page.getByLabel(label,{exact:true}).fill('需要保留的输入');await page.getByRole('button',{name:'离开素材',exact:true}).click();await page.getByRole('alert').filter({hasText:'存在未保存草稿'}).waitFor();assert.equal(await page.getByText('已离开',{exact:true}).count(),0);}
 await page.goto(origin);await page.getByLabel('目标受众',{exact:true}).fill('受众');await page.getByLabel('产品与生成要求').fill('产品');await page.getByLabel('产品与生成要求').fill('');await page.getByRole('button',{name:'离开素材',exact:true}).click();await page.getByRole('alert').filter({hasText:'存在未保存草稿'}).waitFor();
 for(const kind of ['image','video']){await page.goto(origin);await page.getByLabel('输出类型',{exact:true}).selectOption(kind);if(kind==='image')await page.locator('.material-options select').first().selectOption('2:3');else await page.getByLabel('时长（秒）',{exact:true}).fill('10');await page.getByRole('button',{name:'离开素材',exact:true}).click();await page.getByRole('alert').filter({hasText:'存在未保存草稿'}).waitFor();}
 await page.goto(origin);await page.getByLabel('目标受众',{exact:true}).fill('   ');await page.getByLabel('输出类型',{exact:true}).selectOption('image');await page.locator('.material-options select').first().selectOption('2:3');await page.locator('.material-options select').first().selectOption('1:1');await page.getByRole('button',{name:'离开素材',exact:true}).click();await page.getByText('已离开',{exact:true}).waitFor();assert.equal(writes,0);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('both material entries contribute to parent busy and dirty guards without discarding hidden drafts',{timeout:60000},async()=>{
 const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import MarketingMaterials from '/app/components/MarketingMaterials.tsx';function Parent(){const [busy,setBusy]=useState(false),[dirty,setDirty]=useState(false);return <><output data-testid="material-state">{busy?'busy':dirty?'dirty':'clean'}</output><MarketingMaterials notify={()=>{}} onBusyChange={setBusy} onDirtyChange={setDirty}/></>};createRoot(document.getElementById('root')).render(<Parent/>);`;
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture(source);let browser;
 try{browser=await chromium.launch({headless:true});const page=await browser.newPage();let writes=0;await page.route('**/api/marketing-materials',route=>{if(route.request().method()==='POST')writes++;return route.fulfill({json:{tasks:[],availability:{image:true,video:true,presentation:true}}});});
  const state=value=>page.getByTestId('material-state').filter({hasText:value}).waitFor();
  await page.goto(origin);await state('clean');await page.getByLabel('产品与生成要求').fill('图片草稿');await state('dirty');
  await page.getByRole('tab',{name:'数字人',exact:true}).click();await page.getByLabel('数字人测试草稿').fill('数字人草稿');await page.getByLabel('数字人测试草稿').fill('');await state('dirty');
  await page.getByRole('tab',{name:'图文生成',exact:true}).click();assert.equal(await page.getByLabel('产品与生成要求').inputValue(),'图片草稿');await page.getByLabel('产品与生成要求').fill('');await state('clean');
  await page.getByRole('tab',{name:'图文生成',exact:true}).focus();await page.keyboard.press('ArrowRight');await page.getByLabel('数字人测试草稿').fill('数字人草稿');await state('dirty');
  await page.getByRole('button',{name:'开始数字人测试请求',exact:true}).click();await state('busy');assert.equal(await page.getByRole('tab',{name:'图文生成',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'结束数字人测试请求',exact:true}).click();await state('dirty');await page.getByRole('tab',{name:'数字人',exact:true}).focus();await page.keyboard.press('Home');assert.equal(await page.getByLabel('产品与生成要求').inputValue(),'');await state('dirty');assert.equal(writes,0);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('automatic queries stop on save errors, recover the same task and stop after unmount',{timeout:60000},async()=>{
 const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import MarketingMaterials from '/app/components/MarketingMaterials.tsx';function Parent(){const [open,setOpen]=useState(true);return <><button onClick={()=>setOpen(false)}>离开素材</button>{open&&<MarketingMaterials notify={()=>{}}/>}</>};createRoot(document.getElementById('root')).render(<Parent/>);`;
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);
 const {server,origin,cacheDir}=await createFixture(source);let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage();
  await page.clock.install();
  let kind='image',queries=0;const actions=[];
  const task=()=>({id:'accepted-'+kind,requestId:'original-'+kind,version:1,status:'queued',input:{kind,prompt:'已有'+kind+'任务'},progress:0,files:[],slides:[],createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z',pollAt:0});
  await page.route('**/api/marketing-materials',async route=>{
   if(route.request().method()==='GET')return route.fulfill({json:{tasks:[task()],availability:{presentation:true,image:true,video:true}}});
   const body=route.request().postDataJSON();actions.push(body);assert.equal(body.action,'refresh');assert.equal(body.taskId,'accepted-'+kind);queries++;
   const next={...task(),version:queries+1,status:queries===1?'saving':'completed',progress:queries===1?95:100,...(queries===1?{error:'结果暂未安全保存（download_type）'}:{files:[{type:kind==='image'?'image/png':'video/mp4',name:kind==='image'?'图片.png':'视频.mp4',url:'/api/marketing-materials/result?taskId=accepted-'+kind+'&fileIndex=0'}]})};
   return route.fulfill({json:{task:next}});
  });
  await page.route('**/api/marketing-materials/result?*',route=>route.fulfill({contentType:kind==='image'?'image/png':'video/mp4',body:Buffer.from([137,80,78,71])}));
  for(kind of ['image','video']){
   queries=0;await page.goto(origin);await page.getByLabel('输出类型',{exact:true}).selectOption(kind);
   await page.getByRole('button',{name:new RegExp('已有'+kind+'任务')}).click();
   await page.clock.runFor(6100);await page.getByRole('button',{name:'重试保存',exact:true}).waitFor();
   assert.equal(queries,1);
   await page.clock.runFor(24000);assert.equal(queries,1,'a failed save must not poll forever');
   await page.getByRole('button',{name:'重试保存',exact:true}).click();
   await page.locator(kind==='image'?'.material-detail img':'.material-detail video').waitFor();
   const result=page.locator(kind==='image'?'.material-detail img':'.material-detail video');
   assert.match(await result.getAttribute('src'),/^\/api\/marketing-materials\/result\?/);
   assert.equal(queries,2);await page.clock.runFor(18000);assert.equal(queries,2);
  }
  await page.goto(origin);await page.getByLabel('输出类型',{exact:true}).selectOption('video');
  await page.getByRole('button',{name:/已有video任务/}).waitFor();
  const hiddenBefore=actions.length;await page.getByRole('tab',{name:'数字人',exact:true}).click();await page.clock.runFor(18000);assert.equal(actions.length,hiddenBefore,'hidden generation must stop polling');await page.getByRole('tab',{name:'图文生成',exact:true}).click();
  const before=actions.length;await page.getByRole('button',{name:'离开素材',exact:true}).click();
  await page.clock.runFor(60000);assert.equal(actions.length,before);
  assert.equal(actions.some(action=>action.action==='generate'),false);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('the automatic query budget survives output type switches',{timeout:60000},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture(fixture);let browser;
 try{browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.clock.install();const queries={image:0,video:0};
  const task=kind=>({id:'budget-'+kind,requestId:'budget-'+kind,version:queries[kind]+1,status:'queued',input:{kind,prompt:'预算'+kind},progress:0,files:[],slides:[],createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z',pollAt:0});
  await page.route('**/api/material-connection',route=>route.fulfill({json:{connection:{version:0,imageModel:'gpt-image-1-official',enabled:false,storageReady:true}}}));
  await page.route('**/api/marketing-materials',route=>{if(route.request().method()==='GET')return route.fulfill({json:{tasks:[task('image'),task('video')],availability:{image:true,video:true,presentation:false}}});const body=route.request().postDataJSON();assert.equal(body.action,'refresh');const kind=body.taskId==='budget-image'?'image':'video';queries[kind]++;return route.fulfill({json:{task:task(kind)}});});
  await page.goto(origin);await page.getByRole('button',{name:/预算image/}).waitFor();
  async function tick(){const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/marketing-materials'&&r.request().method()==='POST');await page.clock.runFor(6100);await response;await page.waitForFunction(()=>{const button=document.querySelector('.material-detail button');return button&&!button.disabled;});}
  for(let count=0;count<120;count++)await tick();assert.equal(queries.image,120);
  await page.getByLabel('输出类型',{exact:true}).selectOption('video');await tick();assert.equal(queries.video,1);
  await page.getByLabel('输出类型',{exact:true}).selectOption('image');await page.clock.runFor(18000);assert.equal(queries.image,120,'switching output must not reset a task query budget');
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});
