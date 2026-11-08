import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

const root=fileURLToPath(new URL('../',import.meta.url));
const time='2026-11-09T00:00:00Z';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZJcAAAAASUVORK5CYII=','base64');
const mp4=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,2,0]);
const readyConnection={configured:true,enabled:true,storageReady:true,liveReady:true,customizationMode:'zego_platform'};
const disabledConnection={...readyConnection,configured:false,enabled:false,liveReady:false};
const asset=(id,name,status='ready',sourceKind='existing',extra={})=>({id,requestId:'request-'+id,version:1,name,status,sourceKind,...(status==='ready'?{digitalHumanId:'zego-'+id,digitalHumanName:'ZEGO形象'+name}:{}),...(sourceKind!=='existing'?{fileName:name+(sourceKind==='photo'?'.png':'.mp4'),mime:sourceKind==='photo'?'image/png':'video/mp4',size:sourceKind==='photo'?png.length:mp4.length,sourceUrl:'/api/digital-humans/source?assetId='+id}:{}),createdAt:time,updatedAt:time,...extra});
const live=(id,assetId,status='draft',extra={})=>({id,assetId,requestId:'request-'+id,version:1,name:id+'直播',platform:'douyin',hasPushUrl:true,pushUrlDisplay:'rtmp://push.example/live/***',status,hasInstance:status==='running',...(status==='running'?{generationId:'generation-'+id}:{}),createdAt:time,updatedAt:time,...extra});
const clone=value=>structuredClone(value);
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

async function fixture(run,{wrapper=false,clock=false,viewport={width:1280,height:900}}={}){
 const cacheDir=await mkdtemp(path.join(tmpdir(),'digital-human-ui-'));
 const component=wrapper?'MarketingMaterials':'DigitalHumanWorkspace';
 const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import '/app/globals.css';import ${component} from '/app/components/${component}.tsx';function Parent(){const [open,setOpen]=useState(true),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false);return <><div><button onClick={()=>setOpen(false)}>卸载素材界面</button><output data-testid="state">{busy?'busy':dirty?'dirty':'clean'}</output></div><div style={{height:'100vh'}}>${wrapper?'':'<div className="material-workspace">'}{open&&<${component} notify={()=>{}} onBusyChange={setBusy} onDirtyChange={setDirty}/>} ${wrapper?'':'</div>'}</div></>};createRoot(document.getElementById('root')).render(<Parent/>);`;
 const server=await createServer({root,configFile:false,cacheDir,logLevel:'error',resolve:{dedupe:['react','react-dom']},optimizeDeps:{include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','lucide-react']},plugins:[react(),{
  name:'digital-human-fixture',resolveId(id){if(id==='/__digital-human-ui.jsx')return path.join(root,'__digital-human-ui.jsx');},load(id){if(id===path.join(root,'__digital-human-ui.jsx'))return source;},configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/','<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__digital-human-ui.jsx"></script></body></html>'));});}
 }],server:{host:'127.0.0.1',port:0,hmr:false}});
 let browser;
 try{await server.listen();const {chromium}=await import(pathToFileURL(path.join(root,'tools/douyin-bridge/node_modules/playwright/index.mjs')).href);browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport});page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',error=>errors.push(error.message));if(clock)await page.clock.install();await page.route('**/api/**',route=>route.fulfill({status:500,json:{error:'Unexpected local fixture API'}}));await page.route('**/api/marketing-materials',route=>route.fulfill({json:{tasks:[],availability:{presentation:false,image:true,video:true}}}));await run(page,server.resolvedUrls.local[0],errors);}
 finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
}

function localBackend(page,{assets=[],lives=[],connection=readyConnection,onAction,onPut,onRead}={}){
 const state={assets:clone(assets),lives:clone(lives),connection:clone(connection)},actions=[],puts=[],reads=[];
 const replaceAsset=next=>{state.assets=[next,...state.assets.filter(item=>item.id!==next.id)];return next;};
 const replaceLive=next=>{state.lives=[next,...state.lives.filter(item=>item.id!==next.id)];return next;};
 const install=()=>page.route('**/api/digital-humans**',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/api/digital-humans/source'){
   if(req.method()==='GET')return route.fulfill({contentType:url.searchParams.get('assetId')?.includes('video')?'video/mp4':'image/png',body:url.searchParams.get('assetId')?.includes('video')?mp4:png});
   assert.equal(req.method(),'PUT');const before=state.assets.find(item=>item.id===url.searchParams.get('assetId'));assert.ok(before);puts.push({id:before.id,version:Number(url.searchParams.get('version')),mime:req.headers()['content-type'],bytes:req.postDataBuffer()?.length});assert.equal(puts.at(-1).version,before.version);
   const next=replaceAsset({...before,status:'awaiting_customization',version:before.version+1,sourceUrl:'/api/digital-humans/source?assetId='+before.id});
   if(await onPut?.({route,state,next,puts,replaceAsset}))return;
   return route.fulfill({json:{asset:next}});
  }
  assert.equal(url.pathname,'/api/digital-humans');
  if(req.method()==='GET'){const snapshot=clone(state);reads.push(1);if(await onRead?.({route,state,snapshot,reads}))return;return route.fulfill({json:snapshot});}
  assert.equal(req.method(),'POST');const body=req.postDataJSON();actions.push(body);
  if(await onAction?.({route,body,state,actions,puts,replaceAsset,replaceLive}))return;
  if(body.action==='createAsset'){
   const previous=state.assets.find(item=>item.requestId===body.requestId);const next=previous??replaceAsset(asset('upload-'+(state.assets.length+1),body.name,'uploading',body.sourceKind,{requestId:body.requestId,fileName:body.fileName,mime:body.mime,size:body.size,sourceUrl:undefined}));return route.fulfill({json:{asset:next}});
  }
  if(body.action==='bindAvatar'){
   const old=state.assets.find(item=>item.id===body.assetId);assert.equal(body.version,old.version);const next=replaceAsset({...old,version:old.version+1,status:'ready',digitalHumanId:body.digitalHumanId,digitalHumanName:'已核验ZEGO形象'});return route.fulfill({json:{asset:next}});
  }
  if(body.action==='addAvatar'){
   const previous=state.assets.find(item=>item.requestId===body.requestId);const next=previous??replaceAsset(asset('existing-'+state.assets.length,body.name,'ready','existing',{requestId:body.requestId,digitalHumanId:body.digitalHumanId}));return route.fulfill({json:{asset:next}});
  }
  if(body.action==='saveLive'){
   const previous=state.lives.find(item=>item.id===body.liveId);if(previous)assert.equal(body.version,previous.version);const next=replaceLive(live(previous?.id??'live-'+body.assetId,body.assetId,'draft',{name:body.name,requestId:body.requestId,version:(previous?.version??0)+1,platform:body.platform}));return route.fulfill({json:{live:next}});
  }
  if(body.action==='refreshLive'){
   const previous=state.lives.find(item=>item.id===body.liveId);assert.equal(body.version,previous.version);const next=replaceLive({...previous,version:previous.version+1,providerState:'IDLE'});return route.fulfill({json:{live:next}});
  }
  throw new Error('Unexpected fixture mutation '+body.action);
 });
 return {state,actions,puts,reads,install,replaceAsset,replaceLive};
}
async function dropFiles(page,files){const data=await page.evaluateHandle(entries=>{const data=new DataTransfer();for(const entry of entries)data.items.add(new File([Uint8Array.from(entry.bytes)],entry.name,{type:entry.mime}));return data;},files.map(file=>({...file,bytes:[...file.bytes]})));try{await page.locator('.digital-human-drop').dispatchEvent('drop',{dataTransfer:data});}finally{await data.dispose();}}
async function idle(page){await page.waitForFunction(()=>document.querySelector('[data-testid=state]')?.textContent!=='busy');}
async function chooseAsset(page,name){await page.getByLabel('数字人列表',{exact:true}).getByRole('button',{name:new RegExp(name)}).click();}
const sourceInput=page=>page.getByLabel('选择数字人照片或视频',{exact:true});

// These tests never call ZEGO, mutate a real stream or upload private user files.
test('unconfigured ZEGO stores one photo/video honestly and retries an ambiguously accepted upload without a second PUT',{timeout:60000},async()=>{
 await fixture(async(page,origin,errors)=>{
  let losePut=true;const backend=localBackend(page,{connection:disabledConnection,onPut:async({route})=>{if(losePut){losePut=false;await route.abort('failed');return true;}}});await backend.install();await page.goto(origin);await page.getByRole('status').filter({hasText:'ZEGO 服务待配置'}).waitFor();
  await sourceInput(page).setInputFiles({name:'wrong.gif',mimeType:'image/gif',buffer:png});await page.getByRole('alert').filter({hasText:'请选择 PNG'}).waitFor();
  await sourceInput(page).setInputFiles({name:'empty.png',mimeType:'image/png',buffer:Buffer.alloc(0)});await page.getByRole('alert').filter({hasText:'照片须大于 0'}).waitFor();
  await sourceInput(page).setInputFiles({name:'wrong.webm',mimeType:'video/webm',buffer:mp4});await page.getByRole('alert').filter({hasText:'请选择 PNG'}).waitFor();
  await dropFiles(page,[{name:'one.png',mime:'image/png',bytes:png},{name:'two.png',mime:'image/png',bytes:png}]);await page.getByRole('alert').filter({hasText:'每个数字人请选择一张'}).waitFor();assert.equal(backend.actions.length,0);
  await dropFiles(page,[{name:'photo.png',mime:'image/png',bytes:png}]);await page.getByAltText('待上传的数字人照片').waitFor();await page.getByLabel('数字人名称',{exact:true}).fill('照片讲解员');await page.getByRole('button',{name:'保存定制素材',exact:true}).click();await page.getByRole('alert').waitFor();await idle(page);assert.equal(backend.puts.length,1);assert.equal(backend.actions.length,1);
  await page.getByRole('button',{name:'保存定制素材',exact:true}).click();await page.getByRole('article',{name:'照片讲解员数字人详情'}).getByRole('heading',{name:'下一步：完成 ZEGO 形象定制'}).waitFor();await idle(page);
  assert.equal(backend.actions.length,2);assert.equal(backend.actions[0].requestId,backend.actions[1].requestId);assert.equal(backend.puts.length,1);assert.equal(backend.state.assets.length,1);assert.equal(backend.state.assets[0].status,'awaiting_customization');assert.equal(await page.getByLabel('数字人名称',{exact:true}).inputValue(),'');assert.equal(await page.getByRole('region',{name:'数字人直播配置'}).count(),0);assert.equal(await page.getByRole('button',{name:'验证并关联形象'}).isDisabled(),true);
  const preview=page.getByAltText('照片讲解员的定制源照片');assert.match(await preview.getAttribute('src'),/^\/api\/digital-humans\/source\?assetId=/);assert.equal(await page.getByText('上传的原始素材',{exact:true}).count(),1);
  await sourceInput(page).setInputFiles({name:'video.mp4',mimeType:'video/mp4',buffer:mp4});await page.getByLabel('数字人名称',{exact:true}).fill('视频讲解员');await page.getByRole('button',{name:'保存定制素材',exact:true}).click();await page.getByRole('article',{name:'视频讲解员数字人详情'}).getByRole('heading',{name:'下一步：完成 ZEGO 形象定制'}).waitFor();assert.equal(backend.puts.length,2);assert.equal(backend.state.assets.length,2);assert.ok(backend.actions.every(action=>action.action==='createAsset'));assert.equal(await page.locator('.digital-human-source-preview video').count(),1);
  await page.clock.install();const calls=backend.actions.length+backend.reads.length;await page.getByRole('button',{name:'卸载素材界面',exact:true}).click();await page.clock.runFor(60000);assert.equal(backend.actions.length+backend.reads.length,calls);assert.deepEqual(errors,[]);
 });
});

test('a deliberate new file selection retires an ambiguous upload identity even when its metadata matches',{timeout:45000},async()=>{
 await fixture(async(page,origin)=>{
  const backend=localBackend(page,{connection:disabledConnection,onPut:async({route,puts})=>{if(puts.length===1){await route.abort('failed');return true;}}});await backend.install();await page.goto(origin);await page.getByRole('status').filter({hasText:'ZEGO 服务待配置'}).waitFor();
  await sourceInput(page).setInputFiles({name:'same.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'保存定制素材',exact:true}).click();await page.getByRole('alert').waitFor();await idle(page);
  const changed=Buffer.from(png);changed[changed.length-1]^=1;await sourceInput(page).setInputFiles({name:'same.png',mimeType:'image/png',buffer:changed});await page.getByRole('button',{name:'保存定制素材',exact:true}).click();await idle(page);
  assert.equal(backend.actions.length,2);assert.notEqual(backend.actions[0].requestId,backend.actions[1].requestId,'choosing a new source must create a new upload intent');assert.equal(backend.state.assets.length,2);assert.equal(backend.puts.length,2);
 });
});

test('verified avatar binding and existing-avatar addition preserve separate names, binding IDs and live drafts',{timeout:45000},async()=>{
 await fixture(async(page,origin,errors)=>{
  const backend=localBackend(page,{assets:[asset('photo-a','照片甲','awaiting_customization','photo'),asset('video-b','视频乙','awaiting_customization','video')]});await backend.install();await page.goto(origin);await page.getByLabel('ZEGO 形象 ID',{exact:true}).fill('avatar-a');await chooseAsset(page,'视频乙');await page.getByLabel('ZEGO 形象 ID',{exact:true}).fill('avatar-b');await chooseAsset(page,'照片甲');assert.equal(await page.getByLabel('ZEGO 形象 ID',{exact:true}).inputValue(),'avatar-a');
  await page.getByRole('button',{name:'验证并关联形象',exact:true}).click();await page.getByRole('region',{name:'数字人直播配置'}).waitFor();await page.getByLabel('直播名称',{exact:true}).fill('甲的直播');await page.getByLabel('完整推流地址',{exact:true}).fill('rtmp://push.example/live/key-a');
  await chooseAsset(page,'视频乙');assert.equal(await page.getByLabel('ZEGO 形象 ID',{exact:true}).inputValue(),'avatar-b');await page.getByRole('button',{name:'验证并关联形象',exact:true}).click();await page.getByRole('region',{name:'数字人直播配置'}).waitFor();await page.getByLabel('直播名称',{exact:true}).fill('乙的直播');await page.getByLabel('完整推流地址',{exact:true}).fill('rtmp://push.example/live/key-b');await chooseAsset(page,'照片甲');assert.equal(await page.getByLabel('直播名称',{exact:true}).inputValue(),'甲的直播');assert.equal(await page.getByLabel('完整推流地址',{exact:true}).inputValue(),'rtmp://push.example/live/key-a');
  await page.getByText('使用已有 ZEGO 形象',{exact:true}).click();await page.getByLabel('已有形象名称',{exact:true}).fill('本地展示名');await page.getByLabel('已有形象 ID',{exact:true}).fill('public-existing');await page.getByRole('button',{name:'验证并添加',exact:true}).click();await page.getByRole('article',{name:'本地展示名数字人详情'}).waitFor();assert.deepEqual(backend.actions.map(action=>action.action),['bindAvatar','bindAvatar','addAvatar']);assert.equal(backend.actions[2].name,'本地展示名');assert.equal(backend.actions[2].digitalHumanId,'public-existing');assert.equal(await page.locator('.digital-human-source-preview').count(),0);assert.deepEqual(errors,[]);
 });
});

test('saving and reloading live configuration never starts a stream and clears the private push address',{timeout:45000},async()=>{
 await fixture(async(page,origin,errors)=>{
  const backend=localBackend(page,{assets:[asset('one','品牌讲解员')]});await backend.install();await page.goto(origin);await page.getByLabel('直播名称',{exact:true}).fill('招商抖音直播');await page.getByLabel('完整推流地址',{exact:true}).fill('rtmp://push.example/live/private-fixture-key');await page.getByRole('button',{name:'保存直播配置',exact:true}).click();await page.getByRole('status').filter({hasText:'配置已保存'}).waitFor();
  assert.deepEqual(backend.actions.map(action=>action.action),['saveLive']);assert.equal(backend.actions[0].pushUrl,'rtmp://push.example/live/private-fixture-key');assert.equal(await page.getByLabel('完整推流地址',{exact:true}).inputValue(),'');assert.equal(await page.getByLabel('完整推流地址',{exact:true}).getAttribute('type'),'password');assert.match(await page.getByLabel('完整推流地址',{exact:true}).getAttribute('placeholder'),/已安全保存/);assert.ok(!(await page.locator('body').innerText()).includes('private-fixture-key'));
  await page.getByLabel('直播名称',{exact:true}).fill('只改直播名称');await page.getByRole('button',{name:'保存直播配置',exact:true}).click();await idle(page);assert.equal(backend.actions[1].pushUrl,'');assert.equal(backend.actions[1].liveId,'live-one');assert.equal(backend.actions[1].version,1);await page.reload();await page.getByLabel('直播名称',{exact:true}).waitFor();assert.equal(await page.getByLabel('直播名称',{exact:true}).inputValue(),'只改直播名称');assert.equal(await page.getByLabel('完整推流地址',{exact:true}).inputValue(),'');assert.equal(backend.actions.length,2);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);
 });
});

test('an unknown held start blocks duplicate creation and never automatically retries',{timeout:45000},async()=>{
 await fixture(async(page,origin,errors)=>{
  const held=deferred(),started=deferred();const backend=localBackend(page,{assets:[asset('one','讲解员')],lives:[live('live-one','one')],onAction:async({route,body,state,replaceLive})=>{if(body.action!=='startLive')return false;started.resolve();await held.promise;const previous=state.lives[0];await route.fulfill({json:{live:replaceLive({...previous,version:2,status:'start_unknown',hasInstance:false,error:'启动结果待核对'})}});return true;}});await backend.install();await page.goto(origin);const start=page.getByRole('button',{name:'启动推流',exact:true});await start.click();await started.promise;assert.equal(await start.isDisabled(),true);await start.dispatchEvent('click');assert.equal(backend.actions.length,1);held.resolve();await page.getByRole('status').filter({hasText:'启动结果待核对'}).waitFor();assert.equal(await start.isDisabled(),true);await page.clock.runFor(60000);assert.deepEqual(backend.actions.map(action=>action.action),['startLive']);assert.deepEqual(errors,[]);
 },{clock:true});
});

test('explicit start, query, speech and stop execute once; unknown speech locks retry and accepted repeats get a new identity',{timeout:60000},async()=>{
 await fixture(async(page,origin,errors)=>{
  let startHold=deferred(),speakHold=deferred(),stopHold=deferred(),speechCount=0;const startSeen=deferred(),speechSeen=deferred(),stopSeen=deferred();
  const backend=localBackend(page,{assets:[asset('one','讲解员')],lives:[live('live-one','one')],onAction:async({route,body,state,replaceLive})=>{
   const previous=state.lives[0];
   if(body.action==='startLive'){startSeen.resolve();await startHold.promise;await route.fulfill({json:{live:replaceLive({...previous,version:previous.version+1,status:'running',hasInstance:true,generationId:body.requestId})}});return true;}
   if(body.action==='speak'){speechCount++;if(speechCount===1){speechSeen.resolve();await speakHold.promise;}await route.fulfill({json:{live:replaceLive({...previous,version:previous.version+1,lastCommand:{requestId:body.requestId,status:speechCount===1?'unknown':'accepted',text:body.text,createdAt:time}})}});return true;}
   if(body.action==='stopLive'){stopSeen.resolve();await stopHold.promise;await route.fulfill({json:{live:replaceLive({...previous,version:previous.version+1,status:'stopped',hasInstance:false})}});return true;}
   return false;
  }});await backend.install();await page.goto(origin);await page.getByRole('button',{name:'启动推流',exact:true}).click();await startSeen.promise;await page.getByRole('button',{name:'启动推流',exact:true}).dispatchEvent('click');assert.equal(backend.actions.length,1);startHold.resolve();await page.getByRole('textbox',{name:/^直播讲稿/}).waitFor();
  await page.getByRole('button',{name:'查询直播状态',exact:true}).click();await idle(page);assert.equal(backend.actions.filter(action=>action.action==='refreshLive').length,1);
  await page.getByRole('textbox',{name:/^直播讲稿/}).fill('欢迎来到直播间');await page.getByRole('button',{name:'提交播报',exact:true}).click();await speechSeen.promise;await page.locator('.digital-human-script').dispatchEvent('submit');assert.equal(backend.actions.filter(action=>action.action==='speak').length,1);speakHold.resolve();await page.getByRole('status').filter({hasText:'本次播报结果待核对'}).waitFor();assert.equal(await page.getByRole('button',{name:'提交播报',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'再次播报相同讲稿',exact:true}).count(),0);
  assert.equal(await page.getByRole('textbox',{name:/^直播讲稿/}).count(),1,await page.locator('body').innerText());await page.getByRole('textbox',{name:/^直播讲稿/}).fill('介绍下一件商品');await page.getByRole('button',{name:'提交播报',exact:true}).click();await page.getByRole('button',{name:'再次播报相同讲稿',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'提交播报',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'再次播报相同讲稿',exact:true}).click();await idle(page);const speech=backend.actions.filter(action=>action.action==='speak');assert.equal(speech.length,3);assert.notEqual(speech[0].requestId,speech[1].requestId);assert.notEqual(speech[1].requestId,speech[2].requestId);assert.equal(speech[1].text,speech[2].text);
  backend.state.connection={...readyConnection,enabled:false,liveReady:false};await page.getByRole('button',{name:'刷新数字人列表',exact:true}).click();await page.getByRole('status').filter({hasText:'ZEGO 服务待配置'}).waitFor();const stop=page.getByRole('button',{name:'停止推流',exact:true});assert.equal(await stop.isDisabled(),false);assert.equal(await page.getByRole('button',{name:'提交播报',exact:true}).isDisabled(),true);await stop.click();await stopSeen.promise;await stop.dispatchEvent('click');assert.equal(backend.actions.filter(action=>action.action==='stopLive').length,1);stopHold.resolve();await page.getByRole('status').filter({hasText:'已停止'}).waitFor();await page.clock.runFor(60000);assert.equal(backend.actions.filter(action=>action.action==='stopLive').length,1);assert.deepEqual(errors,[]);
 },{clock:true});
});

test('real material wrapper retains photo and live drafts, aggregates busy, pauses hidden polling and fits mobile',{timeout:60000},async()=>{
 await fixture(async(page,origin,errors)=>{
  const held=deferred(),seen=deferred();const backend=localBackend(page,{assets:[asset('running','直播甲'),asset('draft','待配乙')],lives:[live('live-running','running','running')],onAction:async({body})=>{if(body.action==='createAsset'){seen.resolve();await held.promise;}return false;}});await backend.install();await page.goto(origin);await page.getByLabel('产品与生成要求').fill('图文草稿');assert.equal(backend.reads.length,0);await page.getByRole('tab',{name:'数字人',exact:true}).click();await page.getByRole('textbox',{name:/^直播讲稿/}).fill('待播讲稿');await chooseAsset(page,'待配乙');await page.getByLabel('直播名称',{exact:true}).fill('乙的直播草稿');await page.getByLabel('完整推流地址',{exact:true}).fill('rtmp://push.example/live/unsaved-fixture');await sourceInput(page).setInputFiles({name:'my-photo.png',mimeType:'image/png',buffer:png});await page.getByLabel('数字人名称',{exact:true}).fill('未上传照片');await page.getByRole('tab',{name:'图文生成',exact:true}).click();assert.equal(await page.getByLabel('产品与生成要求').inputValue(),'图文草稿');const before=backend.actions.length;await page.clock.runFor(30000);assert.equal(backend.actions.length,before);await page.getByRole('tab',{name:'数字人',exact:true}).click();assert.equal(await page.getByLabel('数字人名称',{exact:true}).inputValue(),'未上传照片');assert.equal(await page.getByLabel('直播名称',{exact:true}).inputValue(),'乙的直播草稿');assert.equal(await page.getByLabel('完整推流地址',{exact:true}).inputValue(),'rtmp://push.example/live/unsaved-fixture');await page.getByAltText('待上传的数字人照片').waitFor();
  await page.getByRole('button',{name:'保存定制素材',exact:true}).click();await seen.promise;await page.getByTestId('state').filter({hasText:'busy'}).waitFor();assert.equal(await page.getByRole('tab',{name:'图文生成',exact:true}).isDisabled(),true);held.resolve();await page.getByRole('article',{name:'未上传照片数字人详情'}).getByRole('heading',{name:'下一步：完成 ZEGO 形象定制'}).waitFor();await idle(page);await page.getByTestId('state').filter({hasText:'dirty'}).waitFor();await chooseAsset(page,'待配乙');assert.equal(await page.getByLabel('直播名称',{exact:true}).inputValue(),'乙的直播草稿');assert.equal(await page.getByLabel('完整推流地址',{exact:true}).inputValue(),'rtmp://push.example/live/unsaved-fixture');
  const artifacts=path.join(root,'.superpowers/sdd/2026-11-09-digital-human-materials/artifacts');await mkdir(artifacts,{recursive:true});for(const [width,height] of [[1280,36],[390,44]]){await page.setViewportSize({width,height:900});const sizes=await page.locator('.digital-human-workspace input:not([type=file]),.digital-human-workspace select').evaluateAll(fields=>fields.map(field=>Math.round(field.getBoundingClientRect().height)).filter(Boolean));assert.ok(sizes.length>0);assert.ok(sizes.every(value=>value===height),JSON.stringify(sizes));await page.screenshot({path:path.join(artifacts,`digital-human-${width}.png`),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,JSON.stringify(await page.locator('body *').evaluateAll(elements=>elements.filter(element=>{const box=element.getBoundingClientRect();return box.width>0&&(box.right>innerWidth+1||box.left<-1);}).slice(0,20).map(element=>({tag:element.tagName,class:element.className,width:Math.round(element.getBoundingClientRect().width),left:Math.round(element.getBoundingClientRect().left)})))));}
  await chooseAsset(page,'直播甲');assert.equal(await page.getByRole('textbox',{name:/^直播讲稿/}).inputValue(),'待播讲稿');await page.clock.runFor(10100);await idle(page);assert.equal(backend.actions.filter(action=>action.action==='refreshLive').length,1);await page.getByRole('tab',{name:'图文生成',exact:true}).click();const hidden=backend.actions.length;await page.clock.runFor(30000);assert.equal(backend.actions.length,hidden);await page.getByRole('button',{name:'卸载素材界面',exact:true}).click();await page.clock.runFor(60000);assert.equal(backend.actions.length,hidden);assert.deepEqual(errors,[]);
 },{wrapper:true,clock:true});
});

test('live status polling stays bounded when switching between running avatars',{timeout:60000},async()=>{
 await fixture(async(page,origin)=>{
  const backend=localBackend(page,{assets:[asset('a','形象甲'),asset('b','形象乙')],lives:[live('live-a','a','running'),live('live-b','b','running')]});await backend.install();await page.goto(origin);await page.getByRole('textbox',{name:/^直播讲稿/}).waitFor();
  async function tick(){const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/digital-humans'&&r.request().method()==='POST');await page.clock.runFor(10100);await response;await idle(page);}
  for(let count=0;count<120;count++)await tick();assert.equal(backend.actions.filter(action=>action.liveId==='live-a').length,120);await chooseAsset(page,'形象乙');await tick();assert.equal(backend.actions.filter(action=>action.liveId==='live-b').length,1);await chooseAsset(page,'形象甲');const unwanted=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/api/digital-humans'&&request.postDataJSON().liveId==='live-a',{timeout:500}).then(()=>true,()=>false);await page.clock.runFor(20200);assert.equal(await unwanted,false,'selecting another avatar must not reset the query budget');assert.equal(backend.actions.filter(action=>action.liveId==='live-a').length,120);
 },{clock:true});
});


test('late list reads retain newer start and stop controls plus newly uploaded assets and saved configs',{timeout:60000},async()=>{
 await fixture(async(page,origin,errors)=>{
  const first=deferred(),firstSeen=deferred(),second=deferred(),secondSeen=deferred();
  const backend=localBackend(page,{assets:[asset('a','形象甲'),asset('b','形象乙')],lives:[live('live-a','a')],onRead:async({route,snapshot,reads})=>{if(reads.length===2){firstSeen.resolve();await first.promise;}else if(reads.length===3){secondSeen.resolve();await second.promise;}else return false;await route.fulfill({json:snapshot});return true;},onAction:async({route,body,state,replaceLive})=>{
   if(!['startLive','stopLive'].includes(body.action))return false;
   const before=state.lives.find(item=>item.id===body.liveId);assert.equal(body.version,before.version);const starting=body.action==='startLive';await route.fulfill({json:{live:replaceLive({...before,version:starting?3:5,status:starting?'running':'stopped',hasInstance:starting,generationId:'generation-a'})}});return true;
  }});await backend.install();await page.goto(origin);await page.getByRole('button',{name:'启动推流',exact:true}).waitFor();
  await page.getByRole('button',{name:'刷新数字人列表',exact:true}).click();await firstSeen.promise;
  await page.getByRole('button',{name:'启动推流',exact:true}).click();await page.getByRole('textbox',{name:/^直播讲稿/}).waitFor();
  await chooseAsset(page,'形象乙');await page.getByLabel('直播名称',{exact:true}).fill('乙的新配置');await page.getByLabel('完整推流地址',{exact:true}).fill('rtmp://push.example/live/stale-fixture');await page.getByRole('button',{name:'保存直播配置',exact:true}).click();await page.getByRole('status').filter({hasText:'配置已保存'}).waitFor();
  await sourceInput(page).setInputFiles({name:'new-source.png',mimeType:'image/png',buffer:png});await page.getByLabel('数字人名称',{exact:true}).fill('新上传形象');await page.getByRole('button',{name:'保存定制素材',exact:true}).click();await page.getByRole('article',{name:'新上传形象数字人详情'}).waitFor();
  const oldRead=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/digital-humans'&&response.request().method()==='GET');first.resolve();await oldRead;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await chooseAsset(page,'形象甲');assert.equal(await page.getByRole('button',{name:'停止推流',exact:true}).isDisabled(),false,'an old draft list must not disable the current running instance stop control');assert.equal(await page.getByRole('button',{name:'启动推流',exact:true}).isDisabled(),true);assert.equal(await page.getByLabel('数字人列表',{exact:true}).getByRole('button',{name:/新上传形象/}).count(),1,'a stale list must retain a newly uploaded asset');
  await chooseAsset(page,'形象乙');assert.equal(await page.getByLabel('直播名称',{exact:true}).inputValue(),'乙的新配置');assert.match(await page.getByLabel('完整推流地址',{exact:true}).getAttribute('placeholder'),/已安全保存/);await chooseAsset(page,'形象甲');
  await page.getByRole('button',{name:'刷新数字人列表',exact:true}).click();await secondSeen.promise;await page.getByRole('button',{name:'停止推流',exact:true}).click();await page.getByRole('status').filter({hasText:'已停止'}).waitFor();const oldRunning=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/digital-humans'&&response.request().method()==='GET');second.resolve();await oldRunning;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.getByRole('button',{name:'停止推流',exact:true}).isDisabled(),true,'an old running list must not revert an accepted stop');assert.equal(await page.getByRole('button',{name:'启动推流',exact:true}).isDisabled(),false);assert.deepEqual(errors,[]);
 });
});

test('speech identities follow the accepted generation across stop and restart including lost start response recovery',{timeout:60000},async()=>{
 for(const loseStartResponse of [false,true])await fixture(async(page,origin,errors)=>{
  const seenSpeech=new Map();let providerSpeeches=0,generationB='';const generationA='generation-a';
  const backend=localBackend(page,{assets:[asset('a','讲解员')],lives:[live('live-a','a','running',{version:3,generationId:generationA})],onAction:async({route,body,state,replaceLive})=>{
   const before=state.lives[0];
   if(body.action==='stopLive'){await route.fulfill({json:{live:replaceLive({...before,version:before.version+1,status:'stopped',hasInstance:false})}});return true;}
   if(body.action==='startLive'){generationB=body.requestId;const next={...before,version:before.version+2,status:'running',hasInstance:true,generationId:generationB};delete next.lastCommand;replaceLive(next);if(loseStartResponse)await route.abort('failed');else await route.fulfill({json:{live:next}});return true;}
   if(body.action==='speak'){
    if(seenSpeech.has(body.requestId)){await route.fulfill({status:409,json:{error:'Speech identity belongs to an earlier generation'}});return true;}
    seenSpeech.set(body.requestId,before.generationId);providerSpeeches++;await route.fulfill({json:{live:replaceLive({...before,version:before.version+1,lastCommand:{requestId:body.requestId,status:before.generationId===generationA?'unknown':'accepted',text:body.text,createdAt:time}})}});return true;
   }
   return false;
  }});await backend.install();await page.goto(origin);await page.getByRole('textbox',{name:/^直播讲稿/}).fill('hello');await page.getByRole('button',{name:'提交播报',exact:true}).click();await page.getByRole('status').filter({hasText:'本次播报结果待核对'}).waitFor();const submit=page.getByRole('button',{name:'提交播报',exact:true});assert.equal(await submit.isDisabled(),true);await submit.dispatchEvent('click');assert.equal(providerSpeeches,1);assert.equal(backend.actions.filter(body=>body.action==='speak').length,1);
  await page.getByRole('button',{name:'停止推流',exact:true}).click();await page.getByRole('status').filter({hasText:'已停止'}).waitFor();await page.getByRole('button',{name:'启动推流',exact:true}).click();
  if(loseStartResponse){await page.getByRole('alert').waitFor();await page.getByRole('button',{name:'刷新数字人列表',exact:true}).click();}
  await page.getByRole('textbox',{name:/^直播讲稿/}).fill('hello');assert.equal(await submit.isDisabled(),false,'the previous generation unknown utterance must not lock a new generation');await submit.click();await idle(page);const speeches=backend.actions.filter(body=>body.action==='speak');assert.equal(speeches.length,2);assert.notEqual(speeches[0].requestId,speeches[1].requestId,'the same words in a newly accepted generation need a new request identity');assert.equal(speeches[1].generationId,generationB);assert.equal(providerSpeeches,2);await page.getByRole('status').filter({hasText:'讲稿已提交给 ZEGO'}).waitFor();assert.deepEqual(errors,[]);
 });
});
