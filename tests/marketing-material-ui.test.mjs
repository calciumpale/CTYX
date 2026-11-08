import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../', import.meta.url));

const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import MarketingMaterials from '/app/components/MarketingMaterials.tsx';import MaterialConnectionSettings from '/app/components/MaterialConnectionSettings.tsx';createRoot(document.getElementById('root')).render(<><div style={{height:'100vh'}}><MarketingMaterials notify={()=>{}}/></div><MaterialConnectionSettings/></>);`;
async function createFixture(source) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'material-ui-vite-'));
  const server = await createServer({
    resolve: { dedupe: ['react', 'react-dom'] }, cacheDir, optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react'] },
    root, configFile: false, logLevel: 'error', plugins: [react(), {
      name: 'material-test-fixture',
      resolveId(id) { if (id === '/__material-fixture.jsx') return path.join(root, '__material-fixture.jsx'); },
      load(id) { if (id === path.join(root, '__material-fixture.jsx')) return source; },
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


test('material tabs retain prompts, missing key disables paid generate, editable PPT exports, mobile fits', {timeout:60000},async()=>{
const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture(fixture);let browser;
try {browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));let connectionWrites=0;
const task={id:'material-test',requestId:'request-test',version:2,status:'completed',input:{kind:'presentation',prompt:'产品演示'},progress:100,files:[],slides:Array.from({length:5},(_,i)=>({title:'产品'+i,bullets:['用户提供的卖点']})),createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z',pollAt:0};
await page.route('**/api/marketing-materials',route=>route.fulfill({json:{tasks:[task],availability:{presentation:true,image:false,video:false}}}));await page.route('**/api/material-connection',route=>{if(route.request().method()==='POST')connectionWrites++;return route.fulfill({json:{connection:{kind:'apimart',configured:false,hasSecret:false,enabled:false,version:0,imageModel:'gpt-image-1-official',storageReady:true},message:'已保存'}});});
await page.goto(origin);await page.getByLabel('产品与生成要求').fill('保留的产品输入');await page.getByRole('tab',{name:'营销图片'}).click();await page.getByLabel('产品与生成要求').fill('保留的图片输入');assert.equal(await page.getByRole('button',{name:'生成营销图片'}).isDisabled(),true);await page.getByRole('tab',{name:'产品演示稿'}).click();assert.equal(await page.getByLabel('产品与生成要求').inputValue(),'保留的产品输入');await page.getByRole('button',{name:/产品演示.*已完成/}).click();await page.getByLabel('标题',{exact:true}).first().fill('编辑后的标题');const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出可编辑 PPTX'}).click();const download=await downloadPromise;assert.match(download.suggestedFilename(),/\.pptx$/);await page.screenshot({path:'.superpowers/sdd/2026-11-08-five-departments/artifacts/material-desktop.png',fullPage:true});
await page.getByLabel(/API Key/).fill('test-key-not-live');await page.getByRole('button',{name:'保存连接',exact:true}).click();assert.equal(connectionWrites,1);await page.waitForFunction(()=>document.querySelector('input[type=password]').value==='');assert.equal(await page.getByLabel(/API Key/).inputValue(),'');await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.superpowers/sdd/2026-11-08-five-departments/artifacts/material-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
}finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('dirty deck guards generation, pending save locks editors, and terminal attempts explicitly renew identity', {timeout:60000},async()=>{
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture(fixture);let browser;
 try{browser=await chromium.launch({headless:true});const page=await browser.newPage();let saveRelease;let saveStarted;const waiting=new Promise(r=>{saveStarted=r;});const held=new Promise(r=>{saveRelease=r;});const ids=[];let status='completed';let deck={id:'deck-0',requestId:'request-0',version:2,status:'completed',input:{kind:'presentation',prompt:'产品'},progress:100,files:[],slides:Array.from({length:5},(_,i)=>({title:'产品'+i,bullets:['卖点']})),createdAt:'2026-11-08T00:00:00Z',updatedAt:'2026-11-08T00:00:00Z',pollAt:0};
 await page.route('**/api/material-connection',r=>r.fulfill({json:{connection:{version:0,imageModel:'gpt-image-1-official',enabled:false,storageReady:true}}}));
 await page.route('**/api/marketing-materials',async route=>{if(route.request().method()==='GET')return route.fulfill({json:{tasks:[deck],availability:{presentation:true,image:true,video:true}}});const body=route.request().postDataJSON();if(body.action==='updateSlides'){saveStarted();await held;deck={...deck,slides:body.slides,version:deck.version+1};return route.fulfill({json:{task:deck}});}ids.push(body.requestId);deck={...deck,id:'deck-'+ids.length,requestId:body.requestId,input:body.input,status};return route.fulfill({json:{task:deck}});});
 await page.goto(origin);await page.getByLabel('产品与生成要求').fill('产品');await page.getByRole('button',{name:/产品.*已完成/}).click();const title=page.getByLabel('标题',{exact:true}).first();await title.fill('未保存的标题');assert.equal(await page.getByRole('button',{name:'生成产品演示稿',exact:true}).isDisabled(),true);await page.locator('.material-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(ids.length,0);assert.equal(await title.inputValue(),'未保存的标题');
 await page.getByRole('button',{name:'保存修改',exact:true}).click();await waiting;assert.equal(await title.isDisabled(),true);assert.equal(await page.getByLabel('要点（每行一条，最多5条）').first().isDisabled(),true);saveRelease();await page.getByRole('button',{name:'生成产品演示稿',exact:true}).click();assert.equal(ids.length,1);await page.getByRole('button',{name:'新建同内容任务',exact:true}).click();assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);status='failed';await page.getByRole('button',{name:'新建同内容任务',exact:true}).click();await page.getByRole('button',{name:'新建同内容任务',exact:true}).click();assert.notEqual(ids[2],ids[3]);
 status='submission_unknown';await page.getByRole('button',{name:'新建同内容任务',exact:true}).click();const unknownId=ids.at(-1);assert.equal(await page.getByRole('button',{name:'新建同内容任务',exact:true}).count(),0);await page.getByRole('button',{name:'生成产品演示稿',exact:true}).click();assert.equal(ids.at(-1),unknownId);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});

test('all material draft inputs trigger the parent leave guard and defaults normalize cleanly', {timeout:60000},async()=>{
 const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import MarketingMaterials from '/app/components/MarketingMaterials.tsx';function Parent(){const [dirty,setDirty]=useState(false),[left,setLeft]=useState(false),[warning,setWarning]=useState(false);return <><button onClick={()=>dirty?setWarning(true):setLeft(true)}>离开素材</button>{warning&&<p role="alert">存在未保存草稿</p>}{left?<p>已离开</p>:<MarketingMaterials notify={()=>{}} onDirtyChange={setDirty}/>}</>};createRoot(document.getElementById('root')).render(<Parent/>);`;
 const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);const {server,origin,cacheDir}=await createFixture(source);let browser;try{browser=await chromium.launch({headless:true});const page=await browser.newPage();let writes=0;await page.route('**/api/marketing-materials',route=>{if(route.request().method()==='POST')writes++;return route.fulfill({json:{tasks:[],availability:{presentation:true,image:true,video:true}}});});
 for(const label of ['目标受众','产品卖点','参考资料']){await page.goto(origin);await page.getByLabel(label,{exact:true}).fill('需要保留的输入');await page.getByRole('button',{name:'离开素材',exact:true}).click();await page.getByRole('alert').filter({hasText:'存在未保存草稿'}).waitFor();assert.equal(await page.getByText('已离开',{exact:true}).count(),0);}
 await page.goto(origin);await page.getByLabel('目标受众',{exact:true}).fill('受众');await page.getByLabel('产品与生成要求').fill('产品');await page.getByLabel('产品与生成要求').fill('');await page.getByRole('button',{name:'离开素材',exact:true}).click();await page.getByRole('alert').filter({hasText:'存在未保存草稿'}).waitFor();
 for(const kind of ['营销图片','营销视频']){await page.goto(origin);await page.getByRole('tab',{name:kind,exact:true}).click();if(kind==='营销图片')await page.locator('.material-options select').first().selectOption('2:3');else await page.getByLabel('时长（秒）',{exact:true}).fill('10');await page.getByRole('button',{name:'离开素材',exact:true}).click();await page.getByRole('alert').filter({hasText:'存在未保存草稿'}).waitFor();}
 await page.goto(origin);await page.getByLabel('目标受众',{exact:true}).fill('   ');await page.getByRole('tab',{name:'营销图片',exact:true}).click();await page.locator('.material-options select').first().selectOption('2:3');await page.locator('.material-options select').first().selectOption('1:1');await page.getByRole('button',{name:'离开素材',exact:true}).click();await page.getByText('已离开',{exact:true}).waitFor();assert.equal(writes,0);
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
   queries=0;await page.goto(origin);await page.getByRole('tab',{name:kind==='image'?'营销图片':'营销视频',exact:true}).click();
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
  await page.goto(origin);await page.getByRole('tab',{name:'营销视频',exact:true}).click();
  await page.getByRole('button',{name:/已有video任务/}).waitFor();
  const before=actions.length;await page.getByRole('button',{name:'离开素材',exact:true}).click();
  await page.clock.runFor(60000);assert.equal(actions.length,before);
  assert.equal(actions.some(action=>action.action==='generate'),false);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});
