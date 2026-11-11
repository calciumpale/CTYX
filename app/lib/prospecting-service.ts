import {DomainError} from './domain.ts';
import {assertMemberOrigin,memberResponseHeaders,outerOwnerId} from './member-auth.ts';
import {assertMemberApi,readMemberDisplayName,requireMemberRole} from './member-policy.ts';
import {readMeetingBody} from './meeting-import-validation.ts';
import {createProspectingStore} from './prospecting-store.ts';
import {normalizeCampaignInput,parseMediaCrawlerExport,prospectId,scoreComment,text} from './prospecting-domain.ts';
import {analyzeProspects,discoverKeywords} from './prospecting-analysis.ts';
import {requestModelText} from './model-client.ts';
import type {EffectiveModel} from './connection-config.ts';
import type {ProspectSnapshot} from './prospecting-types.ts';
import type {ProspectChatAgentInput,ProspectChatDecision} from './prospecting-chat-types.ts';
import type {TaskMemoryState,TaskMemoryMessage,TaskMemoryOptions} from './prospecting-memory-types.ts';

interface Dependencies {learnChat?:(ownerId:string,memberId:string,conversationId:string,campaignId:string,origin:string)=>Promise<{message:string}>;db:D1Database;readModel:(ownerId:string,origin:string)=>Promise<EffectiveModel|null>;decideChat?:(ownerId:string,origin:string,input:ProspectChatAgentInput)=>Promise<ProspectChatDecision>;rememberChat?:(ownerId:string,origin:string,state:TaskMemoryState,messages:TaskMemoryMessage[],options:TaskMemoryOptions)=>Promise<TaskMemoryState>}
const json=(value:unknown)=>Response.json(value,{headers:memberResponseHeaders});
const failure=(error:unknown)=>Response.json({error:error instanceof DomainError?error.message:'获客服务暂时不可用，已保存的任务不会丢失，请稍后刷新'},{status:error instanceof DomainError?error.status:503,headers:memberResponseHeaders});
export function createProspectingService(deps:Dependencies){
 const store=createProspectingStore(deps.db);
 const getModel=async(ownerId:string,origin:string)=>{try{return await deps.readModel(ownerId,origin);}catch{return null;}};
 const generator=(model:EffectiveModel)=>(messages:Parameters<typeof requestModelText>[1])=>requestModelText(model,messages,{timeoutMs:25000});
 async function snapshot(ownerId:string,memberId:string,origin:string,campaignId?:string,leadPage=1,runId?:string):Promise<ProspectSnapshot>{
  const campaigns=await store.campaigns(ownerId,memberId);const selected=campaignId||campaigns[0]?.id;
  const device=await store.device(ownerId,memberId);const campaign=selected?await store.campaign(ownerId,memberId,selected):undefined;
  const page=Math.max(1,Math.floor(leadPage)||1);
  return{discoveryRuns:selected?await store.discovery.runs(ownerId,memberId,selected):[],leadPagination:{page,pageSize:30,total:selected?await store.leadCount(ownerId,memberId,selected,runId):0},campaigns,campaign,device,leads:selected?await store.leads(ownerId,memberId,selected,page,runId):[],jobs:selected?await store.jobs(ownerId,memberId,selected):[],modelReady:!!await getModel(ownerId,origin)};
 }
 /** Each poll processes a small durable batch, so work continues with the page closed. */
 async function analyzeBatch(ownerId:string,memberId:string,origin:string,campaignId?:string):Promise<number>{
  const pending=await store.pendingAnalysis(ownerId,memberId,campaignId,10);if(!pending.length)return 0;
  const model=await getModel(ownerId,origin);if(!model)return 0;
  // One model call per poll stays below the bridge's 45-second request budget.
  const campaignIds=[pending[0].campaignId];
  for(const id of campaignIds){const campaign=await store.campaign(ownerId,memberId,id);const selected=pending.filter(x=>x.campaignId===id);const result=await analyzeProspects(campaign,selected,generator(model));
   for(let i=0;i<selected.length;i++)await store.saveAnalysis(ownerId,memberId,selected[i],result.comments[i],result.error);
  }return pending.length;
 }
 async function handle(request:Request):Promise<Response>{
  try{
   const role=requireMemberRole(request);assertMemberApi(role,'/api/prospecting',request.method);
   const ownerId=outerOwnerId(request),memberId=request.headers.get('x-ctai-member-account-id')!,origin=new URL(request.url).origin;
   if(request.method==='GET'){const query=new URL(request.url).searchParams;if(query.get('mode')==='chat')return json(await store.chat.snapshot(ownerId,memberId,role,query.get('campaignId')||undefined,query.get('conversationId')||undefined));return json(await snapshot(ownerId,memberId,origin,query.get('campaignId')||undefined,Number(query.get('leadPage')||1),query.get('runId')||undefined));}
   assertMemberOrigin(request);const input=await readMeetingBody(request,1600000);const action=input.action;
   let campaignId=typeof input.campaignId==='string'?prospectId(input.campaignId):undefined;let message='操作已保存';let deviceCredentials:Awaited<ReturnType<typeof store.connect>>|undefined;
   if(action==='chatLearn'){if(!campaignId||!deps.learnChat)throw new DomainError('请选择已同步的获客任务',409);const chat=await store.chat.snapshot(ownerId,memberId,role,role==='manager'?undefined:campaignId,prospectId(input.conversationId));const result=await deps.learnChat(ownerId,memberId,prospectId(input.conversationId),campaignId,origin);return json({message:result.message,chat});}
   if(['chatSettings','chatTakeover','chatResume','chatReply','chatSync','chatMemoryEdit','chatSwitchTask'].includes(String(action))){
    if(action==='chatSettings'){if(!campaignId||typeof input.enabled!=='boolean')throw new DomainError('请选择获客任务并设置会话开关');await store.chat.settings(ownerId,memberId,campaignId,input.enabled,input.policy);message=input.enabled?'会话同步和获客助手已开启':'已停止自动同步和回复，未执行的回复已取消';}
    else if(action==='chatSync'){if(!campaignId)throw new DomainError('请选择要同步的会话');const queued=await store.chat.sync(ownerId,memberId,campaignId,prospectId(input.conversationId));message=queued?'已请求助手同步抖音私信':'同步已在队列中或刚完成';}
    else if(action==='chatMemoryEdit'){
     if(!campaignId||!Number.isInteger(input.sessionVersion)||Number(input.sessionVersion)<1||!Number.isInteger(input.bindingVersion)||Number(input.bindingVersion)<1||!['correct','retract','ignore'].includes(String(input.operation)))throw new DomainError('任务记忆版本或操作无效');
     await store.chat.memoryEdit(ownerId,memberId,prospectId(input.conversationId),campaignId,Number(input.sessionVersion),Number(input.bindingVersion),{factId:prospectId(input.factId),operation:input.operation as 'correct'|'retract'|'ignore',...(typeof input.value==='string'?{value:input.value}:{}),actorId:memberId,now:new Date().toISOString()});message='本任务记忆已更新，原来的待发回复已停止';
    }else if(action==='chatSwitchTask'){
     if(!Number.isInteger(input.version)||Number(input.version)<1||!Number.isInteger(input.bindingVersion)||Number(input.bindingVersion)<1)throw new DomainError('会话或接待版本无效');
     const target=prospectId(input.targetCampaignId);await store.chat.switchTask(ownerId,memberId,prospectId(input.conversationId),target,Number(input.version),Number(input.bindingVersion));campaignId=target;message='接待任务已切换；人工接管状态保持不变，核实新消息后才能继续自动回复';
    }else{if(!Number.isInteger(input.version)||Number(input.version)<1)throw new DomainError('会话版本无效');const id=prospectId(input.conversationId);await store.chat.assertActiveCampaign(ownerId,memberId,id,campaignId);
     if(action==='chatTakeover'){await store.chat.takeover(ownerId,memberId,id,Number(input.version));message='已接管会话，助手不会继续自动回复';}
     else if(action==='chatResume'){await store.chat.resume(ownerId,memberId,id,Number(input.version));message='已恢复 AI，将同步核实并继续处理最新未回复的客户消息';}
     else{await store.chat.reply(ownerId,memberId,id,Number(input.version),typeof input.message==='string'?input.message:'');message='人工回复已排队，助手会核对当前会话后提交';}
    }
    return json({message,chat:await store.chat.snapshot(ownerId,memberId,role,campaignId,typeof input.conversationId==='string'?input.conversationId:undefined)});
   }
   if(action==='connect'){deviceCredentials=await store.connect(ownerId,memberId,text(input.label,80));message='配对配置已生成，请下载后交给本机同步助手';}
   else if(action==='disconnect'){await store.disconnect(ownerId,memberId);message='设备已断开，待执行任务已取消；执行中的发送请核对抖音会话';}
   else if(action==='create'){
    if(typeof input.requirements!=='string'||input.requirements.length>2000||input.requirements.trim().length<5)throw new DomainError('请用5至2000个字符描述产品和目标客户');
    let keywords=input.keywords;if(keywords===undefined||Array.isArray(keywords)&&!keywords.length){const model=await getModel(ownerId,origin);keywords=await discoverKeywords(input.requirements,model?generator(model):undefined);}
    const campaign=await store.createCampaign(ownerId,memberId,normalizeCampaignInput({...input,keywords}));campaignId=campaign.id;message='需求已保存，连接后点击发现竞品账号';
   }else{
    if(!campaignId)throw new DomainError('请选择获客任务');
    if(action==='discoverySchedule'){await store.discoverySchedule(ownerId,memberId,campaignId,input.dailyDiscovery);message='每日发现计划已保存';}
    else if(action==='selectCandidates'){if(!Array.isArray(input.candidateIds))throw new DomainError('请选择有效账号');await store.selectCandidates(ownerId,memberId,campaignId,input.candidateIds as string[]);}
    else if(action==='discoveryRun'){await store.discoveryRun(ownerId,memberId,campaignId);message='完整发现轮次已排队';}
    else if(action==='discover'){await store.createJob(ownerId,memberId,campaignId,'discover');message='账号发现已排队，结果会自动刷新';}
    else if(action==='collect'){
     if(!Array.isArray(input.candidateIds)||input.candidateIds.length>30||input.candidateIds.some(x=>typeof x!=='string'))throw new DomainError('请选择有效的竞品账号');
     await store.createJob(ownerId,memberId,campaignId,'collect',input.candidateIds as string[]);message='评论采集已排队，保持本机助手在线即可';
    }else if(action==='review'){
     if(!Number.isInteger(input.version)||Number(input.version)<1||!['approve','reject'].includes(String(input.decision)))throw new DomainError('审核参数不正确');
     await store.review(ownerId,memberId,campaignId,prospectId(input.leadId),Number(input.version),input.decision as 'approve'|'reject',typeof input.greeting==='string'?input.greeting:'',readMemberDisplayName(request));message=input.decision==='approve'?'已审核并排队；提交结果将在执行记录中显示':'已拒绝这条线索';
    }else if(action==='retrySend'){
     if(!Number.isInteger(input.version)||Number(input.version)<1)throw new DomainError('重试参数不正确');
     await store.retrySend(ownerId,memberId,campaignId,prospectId(input.leadId),Number(input.version),readMemberDisplayName(request));message='已按原审核文案排队重试；助手会先核对既有发送记录';
    }else if(action==='pause'||action==='resume'){await store.setPaused(ownerId,memberId,campaignId,action==='pause');message=action==='pause'?'任务已暂停，排队项已取消；执行中的发送不会撤回':'任务已恢复；已取消的招呼需重新审核';}
    else if(action==='import'){const c=await store.campaign(ownerId,memberId,campaignId);const comments=parseMediaCrawlerExport(input.content);await store.insertComments(ownerId,memberId,campaignId,comments.map(x=>scoreComment(x,c)));message='评论已导入用于分析；匿名导入身份不会进入私信队列';}
    else if(action==='analyze'){
     if(!await getModel(ownerId,origin))throw new DomainError('请先联系管理员配置并启用模型，原评论已保留',409);
     if(!(await store.pendingAnalysis(ownerId,memberId,campaignId,1)).length)await store.retryAnalysis(ownerId,memberId,campaignId);
     const count=await analyzeBatch(ownerId,memberId,origin,campaignId);message=`本次已分析${count}条；助手在线会继续处理剩余评论，也可再次点击分析下一批`;
    }else throw new DomainError('不支持的获客操作');
   }
   return json({snapshot:await snapshot(ownerId,memberId,origin,campaignId),...(campaignId?{campaignId}:{}),...(deviceCredentials?{deviceCredentials}:{}),message});
  }catch(error){return failure(error);}
 }
 async function deviceStatus(request:Request):Promise<Response>{
  try{
   if(request.method!=='POST')throw new DomainError('只允许POST请求',405);
   if(request.headers.has('origin')||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('设备接口不接受浏览器跨站请求',403);
   const input=await readMeetingBody(request,16000),deviceId=prospectId(input.deviceId);
   const device=await store.authenticate(deviceId,request.headers.get('authorization')?.replace(/^Bearer /,'')??'');
   if(input.diagnostics===true)return json({ok:true,diagnostics:{...await store.diagnostics(device.owner_id,device.member_id),modelReady:!!await getModel(device.owner_id,new URL(request.url).origin)}});
   await store.touchDevice(deviceId);
   return json({ok:true});
  }catch(error){return failure(error);}
 }
 async function bridge(request:Request,action:'poll'|'heartbeat'|'complete'):Promise<Response>{
  try{
   if(request.method!=='POST')throw new DomainError('只允许POST请求',405);
   if(request.headers.has('origin')||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('设备接口不接受浏览器跨站请求',403);
   const input=await readMeetingBody(request,action==='complete'?1600000:16000);
   const deviceId=prospectId(input.deviceId);const device=await store.authenticate(deviceId,request.headers.get('authorization')?.replace(/^Bearer /,'')??'',true);
   if(action==='poll'){
    await store.seen(deviceId,{authenticated:input.authenticated===true,accountId:typeof input.accountId==='string'?input.accountId:undefined,accountName:text(input.accountName,100),message:text(input.message,500),verifiedReadOnlyAccountId:typeof input.verifiedReadOnlyAccountId==='string'?input.verifiedReadOnlyAccountId:undefined});
    const current=await store.device(device.owner_id,device.member_id);
    if(!current.authenticated)return json({job:null});
    await store.scheduleDiscovery(deviceId);
    const supportsConversations=input.conversationVersion===1;
    const verifiedAccountId=typeof input.verifiedReadOnlyAccountId==='string'&&/^dy-readonly-[a-f0-9]{24}$/.test(input.verifiedReadOnlyAccountId)&&current.accountId===input.accountId&&!current.accountId?.startsWith('dy-readonly-')?current.accountId:undefined;
    const acknowledgement=verifiedAccountId?{verifiedAccountId}:{};
    const quiet=input.quietConversationSync===true;
    const samePassProof=supportsConversations&&quiet&&input.replySamePassProofVersion===1;
    const claim=()=>store.claim(deviceId,input.sendRetryVersion===1,supportsConversations,samePassProof);
    // Persist due inbox observations before prospect analysis or early returns.
    if(supportsConversations)await store.chat.schedule(deviceId,{quiet,...(samePassProof?{replySamePassProofVersion:1}:{})});
    if(supportsConversations)await store.chat.rememberOne(device.owner_id,device.member_id,new URL(request.url).origin,deps.rememberChat);
    if(supportsConversations&&await store.chat.hasQueuedManualSync(deviceId)){
     if(request.signal.aborted)throw new DomainError('请求已取消，未领取新任务',409);
     const queued=await claim();
     if(queued)return json({job:queued,...acknowledgement});
    }
    if(supportsConversations&&await store.chat.hasQueuedConversationWork(deviceId)){
     const stopped=await store.chat.processOne(device.owner_id,device.member_id,new URL(request.url).origin,undefined,true);
     // Continuous reads must not starve already observed inbound turns. Process
     // at most one normal decision, retaining opt-out priority before dispatch.
     if(!stopped)await store.chat.processOne(device.owner_id,device.member_id,new URL(request.url).origin,deps.decideChat);
     if(request.signal.aborted)throw new DomainError('请求已取消，未领取新任务',409);
     const queued=await claim();
     if(queued)return json({job:queued,...acknowledgement});
    }
    const chatProcessed=supportsConversations?await store.chat.processOne(device.owner_id,device.member_id,new URL(request.url).origin,deps.decideChat):false;
    if(!chatProcessed)await analyzeBatch(device.owner_id,device.member_id,new URL(request.url).origin);
    if(request.signal.aborted)throw new DomainError('请求已取消，未领取新任务',409);
    await store.enqueueAutomatic(device.owner_id,device.member_id);
    if(request.signal.aborted)throw new DomainError('请求已取消，未领取新任务',409);
    return json({job:await claim(),...acknowledgement});
   }
   const jobId=prospectId(input.jobId),lease=typeof input.leaseToken==='string'?input.leaseToken:'';
   if(action==='heartbeat'){await store.renew(deviceId,jobId,lease);return json({ok:true});}
   await store.complete(deviceId,jobId,lease,input.result,typeof input.error==='string'?input.error:undefined);return json({ok:true});
  }catch(error){return failure(error);}
 }
 return{handle,bridge,deviceStatus};
}
