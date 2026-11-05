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

interface Dependencies {db:D1Database;readModel:(ownerId:string,origin:string)=>Promise<EffectiveModel|null>}
const json=(value:unknown)=>Response.json(value,{headers:memberResponseHeaders});
const failure=(error:unknown)=>Response.json({error:error instanceof DomainError?error.message:'获客服务暂时不可用，已保存的任务不会丢失，请稍后刷新'},{status:error instanceof DomainError?error.status:503,headers:memberResponseHeaders});
export function createProspectingService(deps:Dependencies){
 const store=createProspectingStore(deps.db);
 const getModel=async(ownerId:string,origin:string)=>{try{return await deps.readModel(ownerId,origin);}catch{return null;}};
 const generator=(model:EffectiveModel)=>(messages:Parameters<typeof requestModelText>[1])=>requestModelText(model,messages,{timeoutMs:25000});
 async function snapshot(ownerId:string,memberId:string,origin:string,campaignId?:string):Promise<ProspectSnapshot>{
  const campaigns=await store.campaigns(ownerId,memberId);const selected=campaignId||campaigns[0]?.id;
  const device=await store.device(ownerId,memberId);const campaign=selected?await store.campaign(ownerId,memberId,selected):undefined;
  return{campaigns,campaign,device,leads:selected?await store.leads(ownerId,memberId,selected):[],jobs:selected?await store.jobs(ownerId,memberId,selected):[],modelReady:!!await getModel(ownerId,origin)};
 }
 /** Each poll processes a small durable batch, so work continues with the page closed. */
 async function analyzeBatch(ownerId:string,memberId:string,origin:string,campaignId?:string):Promise<number>{
  const model=await getModel(ownerId,origin);if(!model)return 0;
  const pending=await store.pendingAnalysis(ownerId,memberId,campaignId,10);if(!pending.length)return 0;
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
   if(request.method==='GET')return json(await snapshot(ownerId,memberId,origin,new URL(request.url).searchParams.get('campaignId')||undefined));
   assertMemberOrigin(request);const input=await readMeetingBody(request,1600000);const action=input.action;
   let campaignId=typeof input.campaignId==='string'?prospectId(input.campaignId):undefined;let message='操作已保存';let deviceCredentials:Awaited<ReturnType<typeof store.connect>>|undefined;
   if(action==='connect'){deviceCredentials=await store.connect(ownerId,memberId,text(input.label,80));message='配对配置已生成，请下载后交给本机同步助手';}
   else if(action==='disconnect'){await store.disconnect(ownerId,memberId);message='设备已断开，待执行任务已取消；执行中的发送请核对抖音会话';}
   else if(action==='create'){
    if(typeof input.requirements!=='string'||input.requirements.length>2000||input.requirements.trim().length<5)throw new DomainError('请用5至2000个字符描述产品和目标客户');
    let keywords=input.keywords;if(keywords===undefined||Array.isArray(keywords)&&!keywords.length){const model=await getModel(ownerId,origin);keywords=await discoverKeywords(input.requirements,model?generator(model):undefined);}
    const campaign=await store.createCampaign(ownerId,memberId,normalizeCampaignInput({...input,keywords}));campaignId=campaign.id;message='需求已保存，连接后点击发现竞品账号';
   }else{
    if(!campaignId)throw new DomainError('请选择获客任务');
    if(action==='discover'){await store.createJob(ownerId,memberId,campaignId,'discover');message='账号发现已排队，结果会自动刷新';}
    else if(action==='collect'){
     if(!Array.isArray(input.candidateIds)||input.candidateIds.length>30||input.candidateIds.some(x=>typeof x!=='string'))throw new DomainError('请选择有效的竞品账号');
     await store.createJob(ownerId,memberId,campaignId,'collect',input.candidateIds as string[]);message='评论采集已排队，保持本机助手在线即可';
    }else if(action==='review'){
     if(!Number.isInteger(input.version)||Number(input.version)<1||!['approve','reject'].includes(String(input.decision)))throw new DomainError('审核参数不正确');
     await store.review(ownerId,memberId,campaignId,prospectId(input.leadId),Number(input.version),input.decision as 'approve'|'reject',typeof input.greeting==='string'?input.greeting:'',readMemberDisplayName(request));message=input.decision==='approve'?'已审核并排队；提交结果将在执行记录中显示':'已拒绝这条线索';
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
 async function bridge(request:Request,action:'poll'|'heartbeat'|'complete'):Promise<Response>{
  try{
   if(request.method!=='POST')throw new DomainError('只允许POST请求',405);
   if(request.headers.has('origin')||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('设备接口不接受浏览器跨站请求',403);
   const input=await readMeetingBody(request,action==='complete'?1600000:16000);
   const deviceId=prospectId(input.deviceId);const device=await store.authenticate(deviceId,request.headers.get('authorization')?.replace(/^Bearer /,'')??'');
   if(action==='poll'){
    await store.seen(deviceId,{authenticated:input.authenticated===true,accountId:typeof input.accountId==='string'?input.accountId:undefined,accountName:text(input.accountName,100),message:text(input.message,500)});
    const current=await store.device(device.owner_id,device.member_id);
    if(!current.authenticated)return json({job:null});
    await analyzeBatch(device.owner_id,device.member_id,new URL(request.url).origin);
    if(request.signal.aborted)throw new DomainError('请求已取消，未领取新任务',409);
    await store.enqueueAutomatic(device.owner_id,device.member_id);
    if(request.signal.aborted)throw new DomainError('请求已取消，未领取新任务',409);
    return json({job:await store.claim(deviceId)});
   }
   const jobId=prospectId(input.jobId),lease=typeof input.leaseToken==='string'?input.leaseToken:'';
   if(action==='heartbeat'){await store.renew(deviceId,jobId,lease);return json({ok:true});}
   await store.complete(deviceId,jobId,lease,input.result,typeof input.error==='string'?input.error:undefined);return json({ok:true});
  }catch(error){return failure(error);}
 }
 return{handle,bridge};
}
