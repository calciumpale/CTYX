import {env} from 'cloudflare:workers';
import {DomainError} from './domain.ts';
import {requireUserId,loadWorkspace,saveWorkspace,refreshSalesProject} from './server.ts';
import {readMemberDisplayName,requireMemberRole} from './member-policy.ts';
import {assertMemberOrigin} from './member-auth.ts';
import {readEffectiveModel} from './connection-store.ts';
import {salesMutationEvents} from './sales-report-domain.ts';
import {analyzeMeetingSource,linkMeetingToWorkspace} from './meeting-analysis.ts';
import {createMeetingStore} from './meeting-import-store.ts';
import {assertMeetingProject,visibleMeetingDeals,validateMeetingRecord,validateMeetingSource,meetingHash,meetingId,meetingHeaders,meetingFailure,readMeetingBody,MAX_MEETING_SOURCE_BYTES,MAX_MEETING_AUDIO_BYTES,sameMeetingSecret} from './meeting-import-validation.ts';
import type {MemberSession} from './member-types.ts';
import type {MeetingImport,MeetingRecord,MeetingMedia,MeetingImportInput} from './meeting-import-types.ts';
import {parseAudioRange} from './followup-recordings.ts';

type MeetingEnv=Cloudflare.Env&{TMEET_BRIDGE_OWNER_ID?:string;TMEET_BRIDGE_SETUP_TOKEN?:string;TMEET_BRIDGE_SETUP_UNTIL?:string};
const runtime=()=>env as MeetingEnv;
function database():D1Database{const db=runtime().DB;if(!db)throw new DomainError('会议数据库尚未连接',503);return db;}
function bucket():R2Bucket{const b=runtime().BUCKET;if(!b)throw new DomainError('会议录音存储尚未连接',503);return b;}
function actor(request:Request):MemberSession{return{role:requireMemberRole(request),accountId:request.headers.get('x-ctai-member-account-id')!,username:request.headers.get('x-ctai-member-username')!,displayName:readMemberDisplayName(request),...(request.headers.get('x-ctai-member-sales-id')?{salesId:request.headers.get('x-ctai-member-sales-id')!}:{})};}
const json=(value:unknown)=>Response.json(value,{headers:meetingHeaders});
const token=(request:Request)=>request.headers.get('authorization')?.replace(/^Bearer /,'')??'';
const online=(seen?:string)=>!!seen&&Date.now()-Date.parse(seen)<75000;

export async function handleMeetingImports(request:Request):Promise<Response>{
 try{
  const ownerId=requireUserId(request),member=actor(request),url=new URL(request.url),store=createMeetingStore(database());
  const state=await loadWorkspace(ownerId,url.origin);
  if(member.role==='admin'){
   if(request.method!=='GET')throw new DomainError('管理员只能查看会议连接状态',403);
   const rows=await database().prepare('SELECT label,last_seen_at,authorized FROM workbench_meeting_devices WHERE owner_id=? AND enabled=1 ORDER BY created_at DESC LIMIT 10').bind(ownerId).all<{label:string;last_seen_at:string|null;authorized:number}>();
   return json({device:{label:rows.results[0]?.label,online:rows.results.some(x=>online(x.last_seen_at??undefined)),authorized:rows.results.some(x=>!!x.authorized)},jobs:[],imports:[]});
  }
  if(request.method==='GET'){
   const importId=url.searchParams.get('importId');if(importId){const imported=await store.getImport(ownerId,meetingId(importId));if(!imported)throw new DomainError('会议内容不存在',404);assertMeetingProject(state,member,imported.dealId);return json({import:imported});}
   let ids=visibleMeetingDeals(state,member);const dealId=url.searchParams.get('dealId');if(dealId){assertMeetingProject(state,member,dealId);ids=[dealId];}
   const device=await store.device(ownerId,member.accountId);const jobs=await store.jobs(ownerId,member.accountId);
   const requested=url.searchParams.get('jobId');if(requested&&!jobs.some(x=>x.id===requested))throw new DomainError('任务不存在或已超出最近任务范围',404);
   return json({device:device?{id:device.id,label:device.label,online:online(device.lastSeenAt),authorized:device.authorized,lastSeenAt:device.lastSeenAt}:{online:false,authorized:false},jobs,imports:await store.imports(ownerId,ids)});
  }
  assertMemberOrigin(request);const input=await readMeetingBody(request);
  if(input.action==='reanalyze'){
   const imported=await store.getImport(ownerId,meetingId(input.importId));if(!imported)throw new DomainError('会议内容不存在',404);assertMeetingProject(state,member,imported.dealId);
   const updated=await analyzeImport(ownerId,imported,url.origin);await linkImport(ownerId,updated,member,url.origin);return json({import:updated});
  }
  const device=await store.device(ownerId,member.accountId);if(!device)throw new DomainError('当前账号尚未绑定腾讯会议同步助手，请联系管理员',503);
  if(!online(device.lastSeenAt))throw new DomainError('本机同步助手离线，请保持这台Mac开机并启动同步助手',503);
  if(!device.authorized)throw new DomainError('请先在这台Mac完成腾讯会议账号登录授权',409);
  if(input.action==='search'){
   const query=typeof input.query==='string'?input.query.trim():'';if(query.length>50)throw new DomainError('会议关键词最多50个字符');
   const code=typeof input.meetingCode==='string'?input.meetingCode.replace(/[\s-]/g,''):'';if(code&&!/^\d{3,20}$/.test(code))throw new DomainError('请输入数字会议号');
   const pageToken=typeof input.pageToken==='string'?input.pageToken:'';if(pageToken.length>4096)throw new DomainError('会议分页标识无效');
   if(pageToken){const previous=(await store.jobs(ownerId,member.accountId)).find(x=>x.kind==='search'&&x.status==='done'&&x.pageToken===pageToken&&x.search?.query=== (query||undefined)&&x.search?.meetingCode===(code||undefined));if(!previous)throw new DomainError('会议列表已更新，请重新搜索',409);}
   return json({job:await store.createJob(ownerId,member.accountId,device.id,'search',{...(query?{query}:{}),...(code?{meetingCode:code}:{}),...(pageToken?{pageToken}:{})})});
  }
  if(input.action==='import'){
   const dealId=meetingId(input.dealId,'项目');assertMeetingProject(state,member,dealId);
   const search=await store.job(ownerId,member.accountId,meetingId(input.searchJobId));
   if(!search||search.kind!=='search'||search.status!=='done'||!search.result_json)throw new DomainError('请先读取并选择你的会议录制',409);
   const source=JSON.parse(search.result_json) as {records:MeetingRecord[]};const found=source.records.find(x=>x.key===input.recordKey);if(!found)throw new DomainError('所选录制不在当前会议列表中',403);
   const record=validateMeetingRecord(found);
   return json({job:await store.createJob(ownerId,member.accountId,device.id,'import',{record,dealId,includeAudio:input.includeAudio===true},dealId)});
  }
  throw new DomainError('不支持的会议操作');
 }catch(error){return meetingFailure(error);}
}

async function analyzeImport(ownerId:string,imported:MeetingImport,origin:string):Promise<MeetingImport>{
 let model:Awaited<ReturnType<typeof readEffectiveModel>>=null;try{model=await readEffectiveModel(ownerId,origin);}catch{/* Original material remains saved. */}
 const analysis=imported.minutes||imported.transcript?await analyzeMeetingSource({minutes:imported.minutes,transcript:imported.transcript},model):{status:'needs_model' as const,summary:'',companies:[],people:[],nextSteps:[],message:'录音已保存；请补充可读取的转写或纪要后再生成客户画像'};
 return createMeetingStore(database()).updateAnalysis(ownerId,imported.id,imported.sourceHash,analysis);
}
async function linkImport(ownerId:string,imported:MeetingImport,member:MemberSession,origin:string){
 for(let retry=0;retry<4;retry++){
  const before=await loadWorkspace(ownerId,origin);assertMeetingProject(before,member,imported.dealId);
  const linked=linkMeetingToWorkspace(before,imported);if(!linked.changed)break;
  try{await saveWorkspace(ownerId,before.revision,linked.state,salesMutationEvents(before,linked.state,'transcript_add',{dealId:imported.dealId},new Date().toISOString()));break;}catch(error){if(!(error instanceof DomainError)||error.status!==409||retry===3)throw error;}
 }
 await createMeetingStore(database()).linked(ownerId,imported.id);
 await refreshSalesProject(ownerId,imported.dealId,origin);
}

/** Private Sites service access is still required in addition to the device credential. */
export async function handleMeetingBridge(request:Request,action:'setup'|'poll'|'heartbeat'|'complete'|'media'):Promise<Response>{
 try{
  if(request.method!=='POST')throw new DomainError('只允许POST请求',405);
  if(request.headers.has('origin')||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('同步服务不接受浏览器跨站调用',403);
  const db=database(),store=createMeetingStore(db);
  if(action==='setup'){
   const environment=runtime();const expected=environment.TMEET_BRIDGE_SETUP_TOKEN??'';
   if(!expected||!sameMeetingSecret(token(request),expected)||!environment.TMEET_BRIDGE_OWNER_ID||!environment.TMEET_BRIDGE_SETUP_UNTIL||!Number.isFinite(Date.parse(environment.TMEET_BRIDGE_SETUP_UNTIL))||Date.parse(environment.TMEET_BRIDGE_SETUP_UNTIL)<=Date.now())throw new DomainError('设备安装凭证无效或已过期',401);
   const input=await readMeetingBody(request);if(input.username!=='sales'&&input.username!=='manager')throw new DomainError('请选择业务账号');
   const ownerId=environment.TMEET_BRIDGE_OWNER_ID;
   const old=await db.prepare('SELECT id FROM workbench_meeting_devices WHERE owner_id=? LIMIT 1').bind(ownerId).first();if(old)throw new DomainError('设备已经完成初始化，请由管理员管理连接',409);
   const account=await db.prepare('SELECT account_id FROM workbench_member_accounts WHERE owner_id=? AND username=? AND enabled=1').bind(ownerId,input.username).first<{account_id:string}>();if(!account)throw new DomainError('业务账号尚未初始化',409);
   const result=await store.createDevice(ownerId,account.account_id,typeof input.label==='string'?input.label:'本机腾讯会议',true);return json({deviceId:result.id,deviceToken:result.token});
  }
  const input=action==='media'?{}:await readMeetingBody(request,action==='complete'?MAX_MEETING_SOURCE_BYTES+160000:16384);
  const deviceId=meetingId(action==='media'?request.headers.get('x-meeting-device-id'):input.deviceId,'设备');
  const device=await store.authenticate(deviceId,token(request));
  if(action==='poll'){
   await store.seen(deviceId,input.authenticated===true);
   return json({job:input.authenticated===true?await store.claim(deviceId):null});
  }
  const jobId=meetingId(action==='media'?request.headers.get('x-meeting-job-id'):input.jobId,'任务');
  const lease=String(action==='media'?request.headers.get('x-meeting-lease-token')??'':input.leaseToken??'');
  const job=await store.leased(deviceId,jobId,lease);
  if(action==='heartbeat'){await store.renew(deviceId,jobId,lease);return json({ok:true});}
  if(action==='media'){
   if(job.kind!=='import'||!(JSON.parse(job.input_json) as MeetingImportInput).includeAudio)throw new DomainError('此任务未请求录音',403);
   const selected=JSON.parse(job.input_json) as MeetingImportInput;const member=await deviceMember(device.ownerId,device.memberId);assertMeetingProject(await loadWorkspace(device.ownerId,new URL(request.url).origin),member,selected.dealId);
   if(job.media_json){await request.body?.cancel();return json({media:JSON.parse(job.media_json)});}
   const length=Number(request.headers.get('content-length'));const contentType=(request.headers.get('content-type')??'').split(';')[0];
   if(!Number.isSafeInteger(length)||length<=0||length>MAX_MEETING_AUDIO_BYTES)throw new DomainError('录音须提供准确长度且不超过50MB',413);
   if(!['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/aac','audio/wav','audio/x-wav','audio/ogg','audio/flac','audio/webm'].includes(contentType))throw new DomainError('仅接收可验证的音频类型',415);
   if(!request.body)throw new DomainError('录音内容为空');
   let name='会议录音';try{name=decodeURIComponent(request.headers.get('x-meeting-filename')??'会议录音');}catch{throw new DomainError('录音文件名不正确');}name=name.replace(/[\u0000-\u001f/\\]/g,'').slice(0,180)||'会议录音';
   const id=`mm-${crypto.randomUUID()}`,key=`meetings/${await meetingHash(device.ownerId)}/${id}`;
   const stream=new FixedLengthStream(length);const pump=request.body.pipeTo(stream.writable);const put=bucket().put(key,stream.readable,{httpMetadata:{contentType}});
   try{await Promise.all([pump,put]);const media=await store.saveMedia(deviceId,jobId,lease,{id,name,contentType,size:length});if(media.id!==id)await bucket().delete(key);return json({media});}catch(error){try{await bucket().delete(key);}catch{/* A future sweep can remove an unreferenced partial object. */}throw error;}
  }
  if(typeof input.error==='string'){await store.complete(deviceId,jobId,lease,null,input.error.replace(/https?:\/\/\S+/g,'[链接已隐藏]').slice(0,700));return json({ok:true});}
  if(job.kind==='search'){
   const result=input.result as {records?:unknown[];hasMore?:unknown;pageToken?:unknown};if(!result||!Array.isArray(result.records)||result.records.length>500)throw new DomainError('会议列表格式不正确');
   const records=result.records.map(x=>validateMeetingRecord(x,true));const pageToken=typeof result.pageToken==='string'&&result.pageToken.length<=4096?result.pageToken:undefined;await store.complete(deviceId,jobId,lease,{records,hasMore:result.hasMore===true,...(pageToken?{pageToken}:{})});return json({ok:true});
  }
  const selected=JSON.parse(job.input_json) as MeetingImportInput;
  const member=await deviceMember(device.ownerId,device.memberId);const state=await loadWorkspace(device.ownerId,new URL(request.url).origin);assertMeetingProject(state,member,selected.dealId);
  const source=validateMeetingSource(input.result,!!job.media_json);const media=job.media_json?JSON.parse(job.media_json) as MeetingMedia:undefined;
  const sourceHash=await meetingHash(JSON.stringify([source.minutes,source.transcript,source.complete]));const id=`mi-${(await meetingHash(`${device.ownerId}\0${selected.dealId}\0${selected.record.recordFileId}\0${sourceHash}`)).slice(0,40)}`;
  const imported:MeetingImport={id,dealId:selected.dealId,record:selected.record,createdAt:new Date().toISOString(),createdBy:member.displayName,sourceHash,...source,...(media?{media}:{}),analysis:{status:'pending',summary:'',companies:[],people:[],nextSteps:[]}};
  const original=await store.insertImport(device.ownerId,device.memberId,deviceId,jobId,lease,imported);
  if(media&&original.media?.id!==media.id){try{await bucket().delete(`meetings/${await meetingHash(device.ownerId)}/${media.id}`);}catch{/* Only this newly uploaded, unreferenced duplicate object is eligible for cleanup. */}}
  let updated=original;
  if(original.analysis.status==='pending')updated=await analyzeImport(device.ownerId,original,new URL(request.url).origin);
  try{await linkImport(device.ownerId,updated,member,new URL(request.url).origin);}catch(error){
   await store.complete(deviceId,jobId,lease,{importId:id},`会议内容已保存，关联项目尚未完成：${error instanceof DomainError?error.message:'请重试分析'}`);return json({ok:true,importId:id});
  }
  await store.complete(deviceId,jobId,lease,{importId:id});return json({ok:true,importId:id});
 }catch(error){return meetingFailure(error);}
}

async function deviceMember(ownerId:string,accountId:string):Promise<MemberSession>{
 const row=await database().prepare("SELECT account_id,username,display_name,role,sales_id FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1 AND role IN ('sales','manager')").bind(ownerId,accountId).first<{account_id:string;username:string;display_name:string;role:'sales'|'manager';sales_id:string|null}>();if(!row)throw new DomainError('关联业务账号已停用',403);return{accountId:row.account_id,username:row.username,displayName:row.display_name,role:row.role,...(row.sales_id?{salesId:row.sales_id}:{})};
}

export async function handleMeetingMedia(request:Request,id:string):Promise<Response>{
 try{
  const ownerId=requireUserId(request),member=actor(request);meetingId(id);if(member.role==='admin')throw new DomainError('当前账号无权读取会议录音',403);
  const row=await database().prepare("SELECT data_json FROM workbench_meeting_imports WHERE owner_id=? AND json_extract(data_json,'$.media.id')=? LIMIT 1").bind(ownerId,id).first<{data_json:string}>();if(!row)throw new DomainError('会议录音不存在',404);
  const imported=JSON.parse(row.data_json) as MeetingImport;assertMeetingProject(await loadWorkspace(ownerId,new URL(request.url).origin),member,imported.dealId);const media=imported.media!;
  const key=`meetings/${await meetingHash(ownerId)}/${id}`;let range:{offset:number;length:number}|undefined;
  if(request.headers.has('range')){try{range=parseAudioRange(request.headers.get('range')!,media.size);}catch{ return new Response(null,{status:416,headers:{...meetingHeaders,'Content-Range':`bytes */${media.size}`}});}}
  const object=await bucket().get(key,range?{range}:undefined);if(!object)throw new DomainError('会议录音暂时不可用',404);
  return new Response(request.method==='HEAD'?null:object.body,{status:range?206:200,headers:{...meetingHeaders,'Content-Type':media.contentType,'Content-Length':String(range?.length??media.size),'Accept-Ranges':'bytes','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(media.name)}`,...(range?{'Content-Range':`bytes ${range.offset}-${range.offset+range.length-1}/${media.size}`}:{})}});
 }catch(error){return meetingFailure(error);}
}
