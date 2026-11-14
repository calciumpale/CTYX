import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {createSeed} from '../app/lib/seed.ts';
import {checkGeoQuality} from '../app/lib/geo-content.ts';
import {RECORDING_INBOX_DEAL_ID} from '../app/lib/recording-inbox-types.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import '/app/globals.css';import Workbench from '/app/components/Workbench.tsx';createRoot(document.getElementById('root')).render(<Workbench member={{accountId:'member-zs',username:'ZS',displayName:'ZS',role:'sales',salesId:'sales-1'}} onLogout={async()=>{}}/>);`;

test('full workbench opens projects, submits a GEO draft and guards material drafts across navigation',{timeout:90000},async()=>{
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
  await page.clock.setFixedTime(new Date('2026-11-14T02:00:00Z'));
  page.on('pageerror',e=>errors.push(e.message));
  const state=createSeed('2026-11-08T00:00:00Z');state.role='sales';state.viewer={name:'ZS',team:'招商',salesId:'sales-1'};
  const deal={...state.deals[0],id:'converted-project',name:'人工核实企业',projectName:'公开来源项目',dataOrigin:'research',contact:'',summary:'公开来源，客户需求待核实',needs:[],notes:[],amount:0,health:0,deadline:'2026-11-13T02:00:00Z',outcome:'open',customerProfile:{decisionChain:'',goals:'已有业务目标',concerns:'',budget:'已有预算',timeline:''}};
  const wav=Buffer.alloc(44+7*16000);
  wav.write('RIFF',0); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length-44,40);
  const recording={id:'fixture-audio',name:'项目跟进.wav',size:wav.length,mimeType:'audio/wav',sourceOnly:true};
  const speakers=[{id:'speaker-1',label:'讲话人 1'},{id:'speaker-2',label:'讲话人 2'}];
  const segments=[
   {start:0,end:3,speaker:speakers[0].id,text:'先核对交付清单。'},
   {start:3,end:7,speaker:speakers[1].id,text:'请把物业要求写进周五的方案。'},
  ];
  const transcriptText=segments.map(segment=>segment.text).join('\n');
  const job={id:'fixture-transcript',dealId:RECORDING_INBOX_DEAL_ID,recordingId:recording.id,status:'completed',linked:false,progress:100,message:'',createdAt:'2026-11-14T02:00:00Z',updatedAt:'2026-11-14T02:00:00Z',result:{text:transcriptText,rawText:transcriptText,segments,speakers,diarization:true,durationSeconds:7,model:'fixture',hotwordVersion:1,corrections:[]}};
  const source={dealId:RECORDING_INBOX_DEAL_ID,recordingId:recording.id,jobId:job.id};
  const reviewedFollowup='周五前复核交付清单及物业要求。';
  const processedDraft={id:'fixture-draft',summary:'讨论了交付与物业要求。',decisions:['把物业要求写进周五的方案。'],followup:'核对交付清单',projectName:deal.projectName,matchedDealId:deal.id,matchReason:'录音内容与可访问项目匹配',profile:{goals:'核对新方案交付范围',budget:'建议预算'},evidence:[segments[1].text],targetVersion:deal.version};
  const expectedApply={dealId:deal.id,version:deal.version,sourceDealId:RECORDING_INBOX_DEAL_ID,recordingId:recording.id,jobId:job.id,draftId:processedDraft.id,profile:{goals:'核对后的交付目标'},followup:reviewedFollowup,confirmed:true};
  const processingRequests=[];
  const applyRequests=[];
  const savedQuote={id:'fixture-quote',dealId:RECORDING_INBOX_DEAL_ID,projectName:'待归属录音',recordingId:recording.id,recordingName:recording.name,speaker:speakers[1].label,start:3,end:7,text:segments[1].text,createdAt:job.createdAt,canDelete:true};
  const quoteRequests=[];
  const removedQuotes=[];
  let quotes=[];
  let uploads=0;
  let inboxSourceReads=0;
  const recentQuery='核对园区项目的交付边界、申请条件和下一次跟进安排';
  state.deals=[];state.runs=[{id:'recent-task',query:recentQuery,answer:'已整理待核对事项。',agentIds:[],steps:[],citations:[],mode:'live',createdAt:'2026-11-14T02:00:00Z',duration:100}];
  let reads=0;
  let geoProject;
  const geoActions=[];
  const article={title:'如何核对园区办公条件',summary:'提前核对园区交付条件。',markdown:'## 交付条件\n核对租期与交付标准 [1]。',faq:[{question:'要核对什么？',answer:'租期与交付标准 [1]。'}]};
  await page.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url()),pathname=url.pathname;
   if(pathname==='/api/workbench'){
    if(request.method()==='POST'){
     const body=request.postDataJSON();
     assert.equal(body.action,'recording_apply');
     assert.deepEqual(body.payload,expectedApply);
     applyRequests.push(body.payload);
     deal.customerProfile={...deal.customerProfile,...body.payload.profile};
     deal.version++;
     return route.fulfill({json:{state:{...state,revision:++reads,deals:[deal]},message:'整理结果已写入项目'}});
    }
    reads++;
    return route.fulfill({json:{...state,revision:reads,deals:reads>1?[deal]:[]}});
   }
   if(pathname==='/api/deal-recordings'){
    if(request.method()==='GET'&&url.searchParams.get('inbox')==='1'){
     if(url.searchParams.has('id')){
      assert.equal(url.searchParams.get('id'),recording.id);
      inboxSourceReads++;
     }
     return route.fulfill({json:{recordings:uploads?[{recording,createdAt:job.createdAt}]:[],nextCursor:null}});
    }
    if(request.method()!=='POST'){
     assert.equal(url.searchParams.get('dealId'),RECORDING_INBOX_DEAL_ID);
     assert.equal(url.searchParams.get('id'),recording.id);
     const range=request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
     const start=range?Number(range[1]):0;
     const end=range?.[2]?Math.min(Number(range[2]),wav.length-1):wav.length-1;
     const media=wav.subarray(start,end+1);
     const headers={'Accept-Ranges':'bytes','Content-Length':String(media.length)};
     if(range) headers['Content-Range']=`bytes ${start}-${end}/${wav.length}`;
     return route.fulfill({status:range?206:200,contentType:'audio/wav',headers,body:media});
    }
    uploads++;
    const body=await new Response(request.postDataBuffer(),{headers:{'Content-Type':request.headers()['content-type']}}).formData();
    assert.equal(body.get('dealId'),RECORDING_INBOX_DEAL_ID);
    assert.equal(body.get('text'),'');
    assert.equal(body.get('sourceOnly'),'true');
    assert.equal(body.get('audio').name,recording.name);
    assert.equal(body.get('audio').size,wav.length);
    return route.fulfill({json:{state:{...state,revision:++reads,deals:[deal]},recording,recordingCreatedAt:job.createdAt,message:'录音已保存'}});
   }
   if(pathname==='/api/recording-transcriptions'){
    assert.equal(request.method(),'GET');
    assert.equal(url.searchParams.get('dealId'),RECORDING_INBOX_DEAL_ID);
    assert.equal(url.searchParams.get('id'),recording.id);
    return route.fulfill({json:{job}});
   }
   if(pathname==='/api/recording-processing'){
    if(request.method()==='GET'){
     assert.deepEqual(Object.fromEntries(url.searchParams),source);
     processingRequests.push('GET');
     return route.fulfill({json:{draft:null,applied:applyRequests.length>0,appliedDealId:applyRequests.length>0?deal.id:null}});
    }
    assert.equal(request.method(),'POST');
    assert.deepEqual(request.postDataJSON(),source);
    processingRequests.push('POST');
    return route.fulfill({json:{draft:processedDraft,applied:false,appliedDealId:null}});
   }
   if(pathname==='/api/recording-quotes'){
    if(request.method()==='GET') return route.fulfill({json:{quotes}});
    if(request.method()==='DELETE'){
     const id=url.searchParams.get('id');
     removedQuotes.push(id);
     quotes=quotes.filter(quote=>quote.id!==id);
     return route.fulfill({json:{ok:true}});
    }
    assert.equal(request.method(),'POST');
    quoteRequests.push(request.postDataJSON());
    quotes=[savedQuote];
    return route.fulfill({json:{quote:savedQuote}});
   }
   if(pathname==='/api/web-prospects')return route.fulfill({json:{tasks:[],leads:[{id:'lead',taskId:'search',version:2,status:'qualified',projectId:deal.id,sourceUrl:'https://example.com/public',title:'人工核实企业公开资料',excerpt:'公开摘要',platform:'other',query:'餐饮',region:'嘉兴',regionMatch:'unverified',retrievedAt:'2026-11-08T00:00:00Z'}]}});
   if(pathname==='/api/geo'){
    if(request.method()==='GET')return route.fulfill({json:{projects:[],modelAvailable:true}});
    const body=request.postDataJSON();geoActions.push(body.action);
    if(body.action==='generate'){
      assert.deepEqual(body.brief.sources,[{title:'园区租赁指南 · 片段 2',url:'',excerpt:'办公空间需核对租期与交付标准。'}]);
      return route.fulfill({json:{article}});
    }
    if(body.action==='check')return route.fulfill({json:{quality:checkGeoQuality(body.document)}});
    if(body.action==='save'){
      geoProject={id:body.id,version:1,updatedAt:'2026-11-12T00:00:00Z',status:'draft',document:body.document,quality:checkGeoQuality(body.document),
        reviewNote:'',observations:[],canEdit:true,canReview:false,canRecord:false};
    }else{
      assert.equal(body.action,'submit');assert.equal(body.version,geoProject.version);assert.equal(geoProject.quality.ready,true);
      geoProject={...geoProject,version:2,status:'in_review',canEdit:false};
    }
    return route.fulfill({json:{project:geoProject}});
   }
   if(pathname==='/api/knowledge-library'&&request.method()==='POST'){
    assert.deepEqual(request.postDataJSON(),{action:'search',query:'园区办公',mode:'bm25'});
    return route.fulfill({json:{hits:[{id:'chunk-2',title:'园区租赁指南',ordinal:2,libraryName:'招商资料',matchedText:'办公空间需核对租期与交付标准。'}],mode:'bm25',notice:null}});
   }
   if(pathname==='/api/content-factory')return route.fulfill({json:{campaigns:[],modelAvailable:false}});
   if(pathname==='/api/marketing-materials')return route.fulfill({json:{tasks:[],availability:{presentation:true,image:false,video:false}}});
   return route.fulfill({json:{pendingCount:0}});
  });
  await page.goto(server.resolvedUrls.local[0]+'?view=prospecting&section=web');
  await page.getByText('公开摘要',{exact:true}).click();
  await page.getByRole('button',{name:'打开已建项目',exact:true}).waitFor();
  await page.screenshot({path:'.superpowers/sdd/2026-11-08-five-departments/artifacts/workbench-web-desktop.png'});
  await page.getByRole('button',{name:'打开已建项目',exact:true}).click();
  await page.locator('.cw-chat-title h2').waitFor();
  assert.equal(await page.locator('.cw-chat-title h2').innerText(),deal.name);
  assert.ok(reads>=2);
  assert.equal(new URL(page.url()).searchParams.get('deal'),deal.id);
  const sidebar=page.getByRole('complementary',{name:'主导航',exact:true});
  const account=sidebar.getByRole('button',{name:'账号菜单',exact:true});
  const businessNav=page.getByRole('navigation',{name:'业务导航'});
  assert.ok((await sidebar.boundingBox()).width<=176);
  assert.ok((await account.boundingBox()).y<(await businessNav.boundingBox()).y,'the account menu sits above business links');
  for(const name of [/搜索工作空间/,/^通知/,/^AI 营销助手$/,/退出登录/]){
   assert.equal(await sidebar.getByRole('button',{name}).count(),0);
  }
  await account.click();
  await sidebar.getByRole('button',{name:'退出登录',exact:true}).waitFor();
  assert.equal(await sidebar.getByRole('button',{name:'搜索工作空间',exact:true,includeHidden:true}).count(),0);
  assert.equal(await sidebar.getByRole('button',{name:'工作动态',exact:true,includeHidden:true}).count(),0);
  await sidebar.getByRole('button',{name:'切换深色主题',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>[document.documentElement.dataset.mode,localStorage.getItem('ctai-theme')]),['dark','dark']);
  const light=sidebar.getByRole('button',{name:'切换浅色主题',exact:true});
  if(!await light.isVisible()) await account.click();
  await light.click();
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.mode),'light');
  if(await sidebar.getByRole('button',{name:'退出登录',exact:true}).isVisible()) await account.click();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('dialog',{name:'搜索工作空间',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();

  const assistant=page.getByRole('button',{name:'AI 营销助手',exact:true});
  const floating=await assistant.boundingBox();
  assert.ok(floating.x>1150&&floating.y>675,'the assistant floats at the bottom right');
  await assistant.click();
  const assistantDialog=page.getByRole('dialog',{name:'AI 营销助手',exact:true});
  await assistantDialog.getByRole('button',{name:'关闭',exact:true}).click();

  const businessNames=await businessNav.getByRole('link').locator('.sidebar-business-label').allTextContents();
  assert.deepEqual(businessNames.slice(0,2),['提醒','AI获客']);
  assert.equal(businessNames.indexOf('AI营销素材'),businessNames.indexOf('GEO')+1);
  assert.equal(businessNames.indexOf('录音处理'),businessNames.indexOf('项目跟进')+1);
  const businessLabels=await businessNav.getByRole('link').locator('.sidebar-business-label').evaluateAll(labels=>labels.map(label=>{
   const {left,width}=label.getBoundingClientRect();
   const textRange=document.createRange();
   textRange.selectNodeContents(label);
   return {left,width,textWidth:textRange.getBoundingClientRect().width,segments:label.childElementCount};
  }));
  assert.equal(businessLabels.length,businessNames.length);
  const [firstLabel]=businessLabels;
  assert.ok(businessLabels.every(label=>Math.abs(label.left-firstLabel.left)<=1),JSON.stringify(businessLabels));
  assert.ok(businessLabels.every(label=>label.segments===0&&Math.abs(label.width-label.textWidth)<=1),'labels keep normal spacing');
  const recent=sidebar.getByRole('button',{name:recentQuery,exact:true});
  assert.equal(await recent.getAttribute('title'),recentQuery);
  const recentLabel=await recent.locator('.sidebar-recent-label').evaluate(label=>{
   const {left,right}=label.getBoundingClientRect();
   const {textOverflow,whiteSpace}=getComputedStyle(label);
   const rightPadding=label.closest('button').getBoundingClientRect().right-right;
   return {left,rightPadding,textOverflow,whiteSpace,truncated:label.scrollWidth>label.clientWidth};
  });
  assert.ok(Math.abs(recentLabel.left-firstLabel.left)<=1,JSON.stringify({recentLabel,firstLabel}));
  assert.ok(recentLabel.rightPadding>=8,'the ellipsis leaves space before the row edge');
  assert.deepEqual([recentLabel.textOverflow,recentLabel.whiteSpace,recentLabel.truncated],['ellipsis','nowrap',true]);
  for(const name of ['日程','合同','AI带练']) await businessNav.getByRole('link',{name,exact:true}).waitFor();
  const reminderLink=businessNav.getByRole('link',{name:/^提醒/});
  await reminderLink.click();
  const reminders=page.getByRole('region',{name:'提醒',exact:true});
  await reminders.getByRole('heading',{name:/^已逾期/}).waitFor();
  await reminders.getByText(deal.projectName,{exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('view'),'reminders');
  assert.equal(await reminderLink.getAttribute('aria-current'),'page');
  await reminders.getByRole('button',{name:'打开项目',exact:true}).click();
  await page.locator('.cw-chat-title h2').getByText(deal.name,{exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('deal'),deal.id);
  const recordingsLink=businessNav.getByRole('link',{name:'录音处理',exact:true});
  await recordingsLink.click();
  await page.getByRole('heading',{name:'录音处理',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('view'),'recordings');
  assert.equal(await recordingsLink.getAttribute('aria-current'),'page');
  const sourceProject=page.getByRole('combobox',{name:'原录音项目',exact:true});
  assert.equal(await sourceProject.inputValue(),RECORDING_INBOX_DEAL_ID);
  await sourceProject.selectOption(deal.id);
  assert.equal(await sourceProject.inputValue(),deal.id);
  await sourceProject.selectOption(RECORDING_INBOX_DEAL_ID);
  await page.getByText('暂无待归属录音，上传后在这里查看转写。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'跟进备注',exact:false}).count(),0);
  const recordingInput=page.getByLabel('选择跟进录音文件',{exact:true});
  const saveRecording=page.getByRole('button',{name:'上传并转写',exact:true});
  assert.match(await recordingInput.getAttribute('accept'),/\.wav/);
  assert.equal(await saveRecording.isDisabled(),true);
  await recordingInput.setInputFiles({name:'错误格式.txt',mimeType:'text/plain',buffer:Buffer.from('fixture')});
  await page.getByRole('alert').getByText(/请选择.*音频/).waitFor();
  assert.equal(await saveRecording.isDisabled(),true);
  assert.equal(uploads,0);
  await recordingInput.setInputFiles({name:recording.name,mimeType:recording.mimeType,buffer:wav});
  await saveRecording.click();
  await page.getByRole('heading',{name:'录音已保存',exact:true}).waitFor();
  assert.equal(uploads,1);
  assert.equal(deal.notes.length,0);
  const turns=page.getByRole('list',{name:'按讲话人分段的录音转写',exact:true}).getByRole('listitem');
  await turns.nth(1).getByText(segments[1].text,{exact:true}).waitFor();
  assert.deepEqual(await turns.locator('.recording-segment-heading > strong').allTextContents(),speakers.map(speaker=>speaker.label));
  const review=page.getByRole('region',{name:'核对整理结果',exact:true});
  await review.getByText(processedDraft.summary,{exact:true}).waitFor();
  assert.deepEqual(processingRequests,['GET','POST']);
  assert.deepEqual(applyRequests,[]);
  assert.equal(await review.getByRole('combobox',{name:'写入项目',exact:true}).inputValue(),deal.id);
  assert.equal(await review.getByRole('checkbox',{name:'替换预算情况',exact:true}).isChecked(),false);
  await review.getByRole('checkbox',{name:'替换业务目标',exact:true}).check();
  await review.getByRole('textbox',{name:'业务目标建议',exact:true}).fill(expectedApply.profile.goals);
  await review.getByRole('textbox',{name:'跟进事项',exact:true}).fill(reviewedFollowup);
  assert.deepEqual(applyRequests,[]);
  await review.getByRole('button',{name:'确认写入',exact:true}).click();
  await page.getByRole('heading',{name:'整理结果已写入',exact:true}).waitFor();
  assert.deepEqual(applyRequests,[expectedApply]);
  assert.equal(deal.customerProfile.budget,'已有预算');
  await turns.nth(1).getByRole('button',{name:'收藏为金句',exact:true}).click();
  await turns.nth(1).getByRole('button',{name:'已收藏',exact:true}).waitFor();
  const quotesTab=page.getByRole('tab',{name:'金句广场',exact:true});
  await quotesTab.click();
  const square=page.getByRole('region',{name:'金句广场',exact:true});
  await square.getByText(savedQuote.text,{exact:true}).waitFor();
  assert.equal(await square.getByText(savedQuote.speaker,{exact:false}).isVisible(),true);
  assert.deepEqual(quoteRequests,[{...source,segmentIndex:1}]);
  await square.getByRole('button',{name:'打开录音',exact:true}).click();
  await page.getByRole('tab',{name:'录音转写',exact:true,selected:true}).waitFor();
  assert.equal(inboxSourceReads,1);
  const audio=page.locator('.followup-recording-saved audio');
  await audio.waitFor();
  await page.waitForFunction(() => Math.abs(document.querySelector('.followup-recording-saved audio')?.currentTime - 3)<0.05,undefined,{timeout:5000});
  await turns.nth(1).getByText(segments[1].text,{exact:true}).waitFor();
  await page.getByRole('heading',{name:'整理结果已写入',exact:true}).waitFor();
  assert.deepEqual(processingRequests,['GET','POST','GET']);
  assert.deepEqual(applyRequests,[expectedApply]);
  await quotesTab.click();
  const removeQuote=square.getByRole('button',{name:'移除金句',exact:true});
  await removeQuote.click();
  const removeDialog=page.getByRole('dialog',{name:'移除金句',exact:true});
  await removeDialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual(removedQuotes,[]);
  assert.equal(await square.getByText(savedQuote.text,{exact:true}).isVisible(),true);
  await removeQuote.click();
  await removeDialog.getByRole('button',{name:'确认移除',exact:true}).click();
  await square.getByText('暂无金句',{exact:true}).waitFor();
  assert.deepEqual(removedQuotes,[savedQuote.id]);
  await businessNav.getByRole('link',{name:'GEO',exact:true}).click();
  await page.locator('.geo-workspace').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('view'),'geo');
  await page.getByRole('button',{name:'新建内容项目',exact:true}).click();
  await page.getByLabel('品牌',{exact:true}).fill('某示例园区');
  await page.getByLabel('选题',{exact:true}).fill('园区办公');
  await page.getByLabel('用户主要问题',{exact:true}).fill('如何核对园区办公条件？');
  await page.getByText('从知识库选取资料',{exact:true}).click();
  await page.getByLabel('知识库关键词').fill('园区办公');
  await page.getByRole('button',{name:'检索',exact:true}).click();
  await page.getByRole('button',{name:'添加片段',exact:true}).click();
  await page.getByRole('button',{name:'AI 生成稿件',exact:true}).click();
  await page.getByRole('heading',{name:article.title,exact:true}).waitFor();
  await page.getByRole('button',{name:'检查质量',exact:true}).click();
  await page.getByText('可以提交审核',{exact:false}).waitFor();
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await page.getByRole('button',{name:'提交审核',exact:true}).click();
  await page.locator('.geo-title').getByText('待审核',{exact:true}).waitFor();
  assert.deepEqual(geoActions,['generate','check','save','submit']);
  assert.equal(await page.getByLabel('品牌',{exact:true}).isDisabled(),true);
  await businessNav.getByRole('link',{name:'AI营销素材',exact:true}).click();
  await page.getByLabel('活动 / 主题',{exact:true}).fill('保留的活动主题');
  await businessNav.getByRole('link',{name:'项目跟进',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:'继续编辑',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await page.getByLabel('活动 / 主题',{exact:true}).inputValue(),'保留的活动主题');
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=1);
  await page.locator('.topbar').getByRole('button',{name:'搜索工作空间',exact:true}).click();
  await page.getByRole('dialog',{name:'搜索工作空间',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
  const mobileNav=page.getByRole('navigation',{name:'快捷导航',exact:true});
  await mobileNav.getByRole('button',{name:'提醒',exact:true}).waitFor();
  const shortcutNames=await mobileNav.getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')));
  assert.equal(shortcutNames.indexOf('录音处理'),shortcutNames.indexOf('项目跟进')+1);
  const shortcuts=await page.locator('.mobile-role-navigation button').evaluateAll(buttons=>buttons.map(button=>({width:button.getBoundingClientRect().width,labelHeight:button.querySelector('span').getBoundingClientRect().height})));
  assert.ok(shortcuts.every(button=>button.width>=44&&button.labelHeight<=20),JSON.stringify(shortcuts));
  await page.screenshot({path:'.superpowers/sdd/2026-11-08-five-departments/artifacts/workbench-material-mobile.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await server.close();await rm(cacheDir,{recursive:true,force:true});}
});
