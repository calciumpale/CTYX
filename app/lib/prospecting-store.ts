import {DomainError} from './domain.ts';
import {canAutoApprove,greetingText,normalizeCandidates,normalizeComments,normalizeCampaignInput,object,prospectHash,prospectToken,safeProspectError,scoreComment,text,MAX_PROSPECT_COMMENTS,PROSPECT_LEASE_MS,PROSPECT_SEND_INTERVAL_MS} from './prospecting-domain.ts';
import type {AnalyzedComment,CampaignInput} from './prospecting-domain.ts';
import type {ProspectBridgeJob,ProspectCampaign,ProspectDeviceView,ProspectJobView,ProspectLead} from './prospecting-types.ts';

interface DeviceRow {id:string;owner_id:string;member_id:string;label:string;token_hash:string;enabled:number;authenticated:number;account_id:string|null;account_name:string|null;message:string|null;last_seen_at:string|null}
interface CampaignRow {id:string;owner_id:string;member_id:string;status:'active'|'paused';data_json:string;created_at:string;updated_at:string}
interface LeadRow {id:string;campaign_id:string;owner_id:string;member_id:string;version:number;status:ProspectLead['status'];job_id:string|null;analysis_attempted:number;data_json:string;updated_at:string;job_status?:ProspectJobView['status'];job_result?:string|null;job_error?:string|null}
export interface ProspectJobRow {id:string;owner_id:string;member_id:string;device_id:string;campaign_id:string;lead_id:string|null;kind:ProspectBridgeJob['kind'];status:ProspectJobView['status'];input_json:string;result_json:string|null;error:string|null;lease_hash:string|null;lease_until:string|null;sender_id:string|null;created_at:string;updated_at:string}
const conflict=()=>new DomainError('线索已更新或状态已改变，请刷新后重新审核',409);
const publicCampaign=(r:CampaignRow):ProspectCampaign=>({...JSON.parse(r.data_json),id:r.id,memberId:r.member_id,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at});
const publicJob=(r:ProspectJobRow):ProspectJobView=>({id:r.id,campaignId:r.campaign_id,kind:r.kind,status:r.status,createdAt:r.created_at,updatedAt:r.updated_at,...(r.lead_id?{leadId:r.lead_id}:{}),...(r.error?{error:r.error}:{}),...(r.result_json?{summary:text(object(JSON.parse(r.result_json)).summary,300)}:{})});
function publicLead(r:LeadRow):ProspectLead{
  let status=r.status;if(r.job_id&&r.job_status){status=r.job_status==='running'?'sending':r.job_status==='done'?'submitted':r.job_status==='cancelled'?'pending':r.job_status;}
  return {...JSON.parse(r.data_json),id:r.id,campaignId:r.campaign_id,version:r.version,status,updatedAt:r.updated_at,...(r.job_error?{error:r.job_error}:{})};
}
const leadSelect='SELECT l.*, j.status AS job_status, j.result_json AS job_result, j.error AS job_error FROM workbench_prospect_leads l LEFT JOIN workbench_prospect_jobs j ON j.id=l.job_id';

export function createProspectingStore(db:D1Database,now:()=>number=Date.now){
 const stamp=()=>new Date(now()).toISOString();
 const member=async(ownerId:string,memberId:string)=>{const found=await db.prepare("SELECT account_id FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1 AND role IN ('sales','manager')").bind(ownerId,memberId).first();if(!found)throw new DomainError('业务账号已停用或无权操作',403);};
 const findDevice=(id:string)=>db.prepare("SELECT d.* FROM workbench_prospect_devices d JOIN workbench_member_accounts a ON a.owner_id=d.owner_id AND a.account_id=d.member_id WHERE d.id=? AND d.enabled=1 AND a.enabled=1 AND a.role IN ('sales','manager')").bind(id).first<DeviceRow>();
 const currentDevice=(ownerId:string,memberId:string)=>db.prepare('SELECT * FROM workbench_prospect_devices WHERE owner_id=? AND member_id=? AND enabled=1 ORDER BY created_at DESC,id DESC LIMIT 1').bind(ownerId,memberId).first<DeviceRow>();
 const online=(d:DeviceRow)=>!!d.last_seen_at&&now()-Date.parse(d.last_seen_at)<90000;
 function deviceView(d:DeviceRow|null):ProspectDeviceView{return d?{id:d.id,label:d.label,online:online(d),authenticated:!!d.authenticated,...(d.account_id?{accountId:d.account_id}:{}),...(d.account_name?{accountName:d.account_name}:{}),...(d.last_seen_at?{lastSeenAt:d.last_seen_at}:{}),...(d.message?{message:d.message}:{})}:{online:false,authenticated:false};}
 async function device(ownerId:string,memberId:string){await member(ownerId,memberId);const d=await currentDevice(ownerId,memberId);if(d)await expire(d.id);return deviceView(d);}
 async function authenticate(id:string,token:string):Promise<DeviceRow>{const d=await findDevice(id);if(!d||!/^[a-f0-9]{64}$/.test(token)||d.token_hash!==await prospectHash(token))throw new DomainError('设备凭证无效或已停用',401);return d;}
 async function disconnect(ownerId:string,memberId:string){
  await member(ownerId,memberId);const time=stamp();
  await db.batch([
   db.prepare('UPDATE workbench_prospect_devices SET enabled=0,authenticated=0 WHERE owner_id=? AND member_id=?').bind(ownerId,memberId),
   db.prepare("UPDATE workbench_prospect_jobs SET status=CASE WHEN kind='send' THEN 'unknown' ELSE 'failed' END,error='设备已断开，执行结果待核对',active_key=NULL,updated_at=? WHERE owner_id=? AND member_id=? AND status='running'").bind(time,ownerId,memberId),
   db.prepare("UPDATE workbench_prospect_jobs SET status='cancelled',recipient_key=NULL,active_key=NULL,error='设备已断开',updated_at=? WHERE owner_id=? AND member_id=? AND status='queued'").bind(time,ownerId,memberId),
   db.prepare("UPDATE workbench_prospect_leads SET job_id=NULL,status='pending',data_json=json_set(data_json,'$.autoSuppressed',1),version=version+1,updated_at=? WHERE owner_id=? AND member_id=? AND job_id IN (SELECT id FROM workbench_prospect_jobs WHERE status='cancelled')").bind(time,ownerId,memberId),
  ]);
 }
 async function connect(ownerId:string,memberId:string,label:string){
  await member(ownerId,memberId);await disconnect(ownerId,memberId);const deviceId=`pd-${crypto.randomUUID()}`,deviceToken=prospectToken();
  await db.prepare('INSERT INTO workbench_prospect_devices(id,owner_id,member_id,label,token_hash,created_at) VALUES (?,?,?,?,?,?)').bind(deviceId,ownerId,memberId,text(label,80)||'本机抖音助手',await prospectHash(deviceToken),stamp()).run();return{deviceId,deviceToken};
 }
 async function seen(id:string,value:{authenticated?:boolean;accountId?:string;accountName?:string;message?:string}){
  const d=await findDevice(id);if(!d)throw new DomainError('设备已停用',401);
  const account=typeof value.accountId==='string'&&/^[a-zA-Z0-9_.-]{5,140}$/.test(value.accountId)?value.accountId:'';
  const changed=!!d.account_id&&!!account&&d.account_id!==account;
  const authenticated=value.authenticated===true&&!!account&&!changed;
  await db.prepare('UPDATE workbench_prospect_devices SET authenticated=?,account_id=COALESCE(account_id,?),account_name=?,message=?,last_seen_at=? WHERE id=? AND enabled=1').bind(authenticated?1:0,authenticated?account:null,text(value.accountName,100)||null,changed?'抖音登录账号已改变，请切回原账号或重新绑定设备':safeProspectError(value.message)||null,stamp(),id).run();
 }
 async function createCampaign(ownerId:string,memberId:string,input:CampaignInput):Promise<ProspectCampaign>{
  await member(ownerId,memberId);const normalized=normalizeCampaignInput(input),time=stamp(),id=`pc-${crypto.randomUUID()}`;
  const c={...normalized,candidates:[],selectedCandidateIds:[]};await db.prepare('INSERT INTO workbench_prospect_campaigns(id,owner_id,member_id,status,data_json,created_at,updated_at) VALUES (?,?,?,\'active\',?,?,?)').bind(id,ownerId,memberId,JSON.stringify(c),time,time).run();return {...c,id,memberId,status:'active',createdAt:time,updatedAt:time};
 }
 async function campaigns(ownerId:string,memberId:string){await member(ownerId,memberId);const r=await db.prepare('SELECT * FROM workbench_prospect_campaigns WHERE owner_id=? AND member_id=? ORDER BY created_at DESC,id DESC LIMIT 50').bind(ownerId,memberId).all<CampaignRow>();return r.results.map(publicCampaign);}
 async function campaign(ownerId:string,memberId:string,id:string):Promise<ProspectCampaign>{await member(ownerId,memberId);const r=await db.prepare('SELECT * FROM workbench_prospect_campaigns WHERE owner_id=? AND member_id=? AND id=?').bind(ownerId,memberId,id).first<CampaignRow>();if(!r)throw new DomainError('获客任务不存在',404);return publicCampaign(r);}
 async function leads(ownerId:string,memberId:string,campaignId:string){await campaign(ownerId,memberId,campaignId);const r=await db.prepare(`${leadSelect} WHERE l.owner_id=? AND l.member_id=? AND l.campaign_id=? ORDER BY json_extract(l.data_json,'$.intentScore') DESC,l.id LIMIT ${MAX_PROSPECT_COMMENTS}`).bind(ownerId,memberId,campaignId).all<LeadRow>();return r.results.map(publicLead);}
 async function jobs(ownerId:string,memberId:string,campaignId:string){await campaign(ownerId,memberId,campaignId);const r=await db.prepare('SELECT * FROM workbench_prospect_jobs WHERE owner_id=? AND member_id=? AND campaign_id=? ORDER BY created_at DESC,id DESC LIMIT 100').bind(ownerId,memberId,campaignId).all<ProspectJobRow>();return r.results.map(publicJob);}
 async function setPaused(ownerId:string,memberId:string,id:string,paused:boolean){
  await campaign(ownerId,memberId,id);const statements=[db.prepare('UPDATE workbench_prospect_campaigns SET status=?,updated_at=? WHERE id=? AND owner_id=? AND member_id=?').bind(paused?'paused':'active',stamp(),id,ownerId,memberId)];
  if(paused){statements.push(db.prepare("UPDATE workbench_prospect_jobs SET status='cancelled',active_key=NULL,recipient_key=NULL,error='任务已暂停',updated_at=? WHERE campaign_id=? AND owner_id=? AND member_id=? AND status='queued'").bind(stamp(),id,ownerId,memberId),db.prepare("UPDATE workbench_prospect_leads SET job_id=NULL,status='pending',data_json=json_set(data_json,'$.autoSuppressed',1),version=version+1,updated_at=? WHERE campaign_id=? AND owner_id=? AND member_id=? AND job_id IN (SELECT id FROM workbench_prospect_jobs WHERE status='cancelled')").bind(stamp(),id,ownerId,memberId));}
  await db.batch(statements);
 }
 async function readyDevice(ownerId:string,memberId:string){const d=await currentDevice(ownerId,memberId);if(!d||!online(d))throw new DomainError('请先连接并启动本机抖音助手',503);if(!d.authenticated||!d.account_id)throw new DomainError('请在本机浏览器登录绑定的抖音账号',409);return d;}
 async function createJob(ownerId:string,memberId:string,campaignId:string,kind:'discover'|'collect',candidateIds:string[]=[]){
  const c=await campaign(ownerId,memberId,campaignId);if(c.status!=='active')throw new DomainError('请先恢复任务',409);const d=await readyDevice(ownerId,memberId);
  const selected=c.candidates.filter(x=>candidateIds.includes(x.id));if(kind==='collect'&&(!selected.length||selected.length!==new Set(candidateIds).size))throw new DomainError('请从当前候选账号中选择采集目标');
  const videos=[...new Map(selected.flatMap(x=>x.videos).map(x=>[x.id,x])).values()];if(kind==='collect'&&!videos.length)throw new DomainError('所选账号没有可采集的来源视频，请重新发现账号');if(videos.length>20)throw new DomainError('每次最多采集20条来源视频，请减少账号数量');
  const input=kind==='discover'?{keywords:c.keywords,requirements:c.requirements}:{videos,maxCommentsPerVideo:c.maxCommentsPerVideo};
  const id=`pj-${crypto.randomUUID()}`,activeKey=`${campaignId}:${kind}`,time=stamp();
  const result=await db.prepare("INSERT OR IGNORE INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,kind,status,input_json,active_key,created_at,updated_at) SELECT ?,?,?,?,?,?,'queued',?,?,?,? WHERE EXISTS (SELECT 1 FROM workbench_prospect_campaigns WHERE id=? AND status='active')").bind(id,ownerId,memberId,d.id,campaignId,kind,JSON.stringify(input),activeKey,time,time,campaignId).run();
  if(!result.meta.changes)throw new DomainError('同类任务已在运行或任务已暂停，请等待结果',409);
  if(kind==='collect')await db.prepare("UPDATE workbench_prospect_campaigns SET data_json=json_set(data_json,'$.selectedCandidateIds',json(?)),updated_at=? WHERE id=? AND owner_id=? AND member_id=?").bind(JSON.stringify(selected.map(x=>x.id)),time,campaignId,ownerId,memberId).run();
 }
 async function insertComments(ownerId:string,memberId:string,campaignId:string,comments:AnalyzedComment[]){
  const c=await campaign(ownerId,memberId,campaignId);const existing=await leads(ownerId,memberId,campaignId);const keys=new Set(existing.map(x=>`${x.videoId}:${x.id}`));const statements:D1PreparedStatement[]=[];
  for(const comment of comments){if(keys.has(`${comment.videoId}:${comment.id}`))continue;if(keys.size>=MAX_PROSPECT_COMMENTS)break;keys.add(`${comment.videoId}:${comment.id}`);const status=comment.recipientId&&comment.profileUrl?'pending':'unreachable';
   statements.push(db.prepare('INSERT OR IGNORE INTO workbench_prospect_leads(id,campaign_id,owner_id,member_id,status,data_json,updated_at) SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM workbench_prospect_leads WHERE campaign_id=?)<300').bind(comment.id,campaignId,ownerId,memberId,status,JSON.stringify(comment),stamp(),campaignId));
  }
  for(let i=0;i<statements.length;i+=40)await db.batch(statements.slice(i,i+40));
  // Automatic approval is applied only to saved model analysis, never raw crawler output.
  void c;
 }
 async function review(ownerId:string,memberId:string,campaignId:string,leadId:string,version:number,decision:'approve'|'reject',greeting:string,reviewer:string,automatic=false){
  const c=await campaign(ownerId,memberId,campaignId);if(c.status!=='active')throw new DomainError('任务已暂停，请恢复后再审核',409);
  const row=await db.prepare(`${leadSelect} WHERE l.campaign_id=? AND l.id=? AND l.owner_id=? AND l.member_id=?`).bind(campaignId,leadId,ownerId,memberId).first<LeadRow>();if(!row)throw new DomainError('线索不存在',404);
  if(row.version!==version||!['pending','rejected','unreachable'].includes(publicLead(row).status))throw conflict();
  const lead=publicLead(row);if(automatic&&!canAutoApprove(lead,c))throw new DomainError('此线索不满足自动审核条件',409);
  const message=decision==='approve'?greetingText(greeting):lead.greeting;
  const updated={...JSON.parse(row.data_json),greeting:message,reviewedBy:reviewer,reviewedAt:stamp()};
  if(decision==='reject'){const r=await db.prepare("UPDATE workbench_prospect_leads SET status='rejected',data_json=?,version=version+1,updated_at=? WHERE campaign_id=? AND id=? AND owner_id=? AND member_id=? AND version=? AND job_id IS NULL").bind(JSON.stringify(updated),stamp(),campaignId,leadId,ownerId,memberId,version).run();if(!r.meta.changes)throw conflict();return;}
  if(!lead.recipientId||!lead.profileUrl||lead.source!=='browser')throw new DomainError('评论缺少可联系的公开身份，不能私信',409);
  const d=await readyDevice(ownerId,memberId);if(lead.recipientId===d.account_id)throw new DomainError('不能向当前登录账号发送获客私信');
  const recipientKey=await prospectHash(`${ownerId}\0${d.account_id}\0${lead.recipientId}`);
  if(await db.prepare('SELECT id FROM workbench_prospect_jobs WHERE recipient_key=?').bind(recipientKey).first())throw new DomainError('此发送账号已安排或已触达该用户，请勿重复打招呼',409);
  const id=`pj-${crypto.randomUUID()}`,time=stamp();
  const input={recipientId:lead.recipientId,profileUrl:lead.profileUrl,message,senderAccountId:d.account_id};
  const results=await db.batch([
   db.prepare("INSERT OR IGNORE INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,recipient_key,sender_id,created_at,updated_at) SELECT ?,?,?,?,?,?,'send','queued',?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workbench_prospect_leads WHERE campaign_id=? AND id=? AND owner_id=? AND member_id=? AND version=? AND job_id IS NULL AND status IN ('pending','rejected')) AND EXISTS (SELECT 1 FROM workbench_prospect_campaigns WHERE id=? AND status='active') AND EXISTS (SELECT 1 FROM workbench_prospect_devices WHERE id=? AND enabled=1 AND authenticated=1 AND account_id=?)").bind(id,ownerId,memberId,d.id,campaignId,leadId,JSON.stringify(input),recipientKey,d.account_id,time,time,campaignId,leadId,ownerId,memberId,version,campaignId,d.id,d.account_id),
   db.prepare("UPDATE workbench_prospect_leads SET status='queued',job_id=?,data_json=?,version=version+1,updated_at=? WHERE campaign_id=? AND id=? AND owner_id=? AND member_id=? AND version=? AND EXISTS (SELECT 1 FROM workbench_prospect_jobs WHERE id=?)").bind(id,JSON.stringify(updated),time,campaignId,leadId,ownerId,memberId,version,id),
  ]);if(!results[0].meta.changes||!results[1].meta.changes)throw conflict();
 }
 async function expire(deviceId:string){await db.prepare("UPDATE workbench_prospect_jobs SET status=CASE WHEN kind='send' THEN 'unknown' ELSE 'failed' END,error=CASE WHEN kind='send' THEN '发送租约已过期，结果待核对；不会自动重发' ELSE '采集超时，请重新发起' END,active_key=NULL,updated_at=? WHERE owner_id=(SELECT owner_id FROM workbench_prospect_devices WHERE id=?) AND status='running' AND lease_until<=?").bind(stamp(),deviceId,stamp()).run();}
 async function claim(deviceId:string):Promise<ProspectBridgeJob|null>{
  const d=await findDevice(deviceId);if(!d)throw new DomainError('设备已停用',401);await expire(deviceId);if(!d.authenticated||!d.account_id)return null;
  const leaseToken=prospectToken(),time=stamp();const dayStart=new Date(Math.floor((now()+8*3600000)/86400000)*86400000-8*3600000).toISOString();
  const row=await db.prepare(`UPDATE workbench_prospect_jobs SET status='running',lease_hash=?,lease_until=?,started_at=?,updated_at=? WHERE id=(
    SELECT j.id FROM workbench_prospect_jobs j JOIN workbench_prospect_campaigns c ON c.id=j.campaign_id
    WHERE j.device_id=? AND j.owner_id=? AND j.member_id=? AND j.status='queued' AND c.status='active'
    AND EXISTS (SELECT 1 FROM workbench_prospect_devices d JOIN workbench_member_accounts m ON m.account_id=d.member_id AND m.owner_id=d.owner_id WHERE d.id=j.device_id AND d.enabled=1 AND d.authenticated=1 AND m.enabled=1 AND m.role IN ('sales','manager'))
    AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs running WHERE running.device_id=j.device_id AND running.status='running')
    AND (j.kind!='send' OR (j.sender_id=?
      AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs other WHERE other.owner_id=j.owner_id AND other.sender_id=j.sender_id AND other.status='running')
      AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs recent WHERE recent.owner_id=j.owner_id AND recent.sender_id=j.sender_id AND recent.started_at>?)
      AND (SELECT COUNT(*) FROM workbench_prospect_jobs day WHERE day.owner_id=j.owner_id AND day.sender_id=j.sender_id AND day.started_at>=?)<CAST(json_extract(c.data_json,'$.dailyLimit') AS INTEGER)))
    ORDER BY CASE j.kind WHEN 'send' THEN 1 ELSE 0 END,j.created_at,j.id LIMIT 1) RETURNING *`).bind(await prospectHash(leaseToken),new Date(now()+PROSPECT_LEASE_MS).toISOString(),time,time,deviceId,d.owner_id,d.member_id,d.account_id,new Date(now()-PROSPECT_SEND_INTERVAL_MS).toISOString(),dayStart).first<ProspectJobRow>();
  return row?{id:row.id,campaignId:row.campaign_id,kind:row.kind,leaseToken,input:JSON.parse(row.input_json)}:null;
 }
 async function leased(deviceId:string,id:string,token:string,allowTerminal=false):Promise<ProspectJobRow>{
  const d=await findDevice(deviceId);const r=await db.prepare('SELECT * FROM workbench_prospect_jobs WHERE id=? AND device_id=?').bind(id,deviceId).first<ProspectJobRow>();
  if(!d||!r||r.owner_id!==d.owner_id||r.member_id!==d.member_id||!/^[a-f0-9]{64}$/.test(token)||r.lease_hash!==await prospectHash(token))throw new DomainError('执行凭证无效',409);
  if(allowTerminal&&['done','failed','unknown'].includes(r.status))return r;
  if(r.status!=='running'||!r.lease_until||r.lease_until<=stamp())throw new DomainError('任务执行凭证已过期',409);return r;
 }
 async function renew(deviceId:string,id:string,token:string){
  const r=await leased(deviceId,id,token);const d=(await findDevice(deviceId))!;const c=await campaign(d.owner_id,d.member_id,r.campaign_id);
  if(c.status!=='active'||!d.authenticated)throw new DomainError('任务已暂停或登录已失效，请停止执行',409);
  if(Date.parse(r.created_at)<now()-24*3600000)throw new DomainError('任务已超过执行时限',409);
  await db.prepare("UPDATE workbench_prospect_jobs SET lease_until=?,updated_at=? WHERE id=? AND lease_hash=? AND status='running'").bind(new Date(now()+PROSPECT_LEASE_MS).toISOString(),stamp(),id,r.lease_hash).run();
 }
 async function complete(deviceId:string,id:string,token:string,result:unknown,error?:string){
  const r=await leased(deviceId,id,token,true);if(['done','failed','unknown'].includes(r.status))return;
  if(!r.lease_until||r.lease_until<=stamp()){await expire(deviceId);throw new DomainError('任务已过期，发送结果需核对',409);}
  let status:ProspectJobView['status']='done',summary='',safeResult:unknown={};let problem=safeProspectError(error);
  if(problem){status=r.kind==='send'?'unknown':'failed';}
  else if(r.kind==='send'){
   const v=object(result);if(!['submitted','unknown','failed'].includes(String(v.outcome)))throw new DomainError('私信执行结果格式不正确');
   status=v.outcome==='submitted'?'done':v.outcome as 'unknown'|'failed';problem=safeProspectError(v.error);summary=v.outcome==='submitted'?'已提交，未验证送达或已读':v.outcome==='unknown'?'结果待核对，不自动重发':'提交失败';safeResult={outcome:v.outcome,evidence:text(v.evidence,500),summary};
  }else if(r.kind==='discover'){
   const candidates=normalizeCandidates(object(result).candidates);summary=`发现${candidates.length}个相关账号`;
   await db.prepare("UPDATE workbench_prospect_campaigns SET data_json=json_set(data_json,'$.candidates',json(?),'$.selectedCandidateIds',json('[]')),updated_at=? WHERE id=? AND owner_id=? AND member_id=?").bind(JSON.stringify(candidates),stamp(),r.campaign_id,r.owner_id,r.member_id).run();safeResult={summary};
  }else{
   const comments=normalizeComments(object(result).comments,'browser');const input=JSON.parse(r.input_json) as ProspectBridgeJob['input'];const allowed=new Set(input.videos?.map(v=>v.id));if(comments.some(c=>!allowed.has(c.videoId)))throw new DomainError('采集结果包含未选择的视频',403);
   const c=await campaign(r.owner_id,r.member_id,r.campaign_id);await insertComments(r.owner_id,r.member_id,r.campaign_id,comments.map(x=>scoreComment(x,c)));summary=`读取${comments.length}条评论（每个任务最多保留${MAX_PROSPECT_COMMENTS}条）`;safeResult={summary,warnings:Array.isArray(object(result).warnings)?(object(result).warnings as unknown[]).slice(0,10).map(safeProspectError):[]};
  }
  await db.prepare("UPDATE workbench_prospect_jobs SET status=?,result_json=?,error=?,active_key=NULL,updated_at=? WHERE id=? AND device_id=? AND status='running' AND lease_hash=?").bind(status,JSON.stringify(safeResult),problem||null,stamp(),id,deviceId,r.lease_hash).run();
 }
 async function pendingAnalysis(ownerId:string,memberId:string,campaignId?:string,limit=10){
  await member(ownerId,memberId);const rows=await db.prepare(`${leadSelect} JOIN workbench_prospect_campaigns c ON c.id=l.campaign_id WHERE l.owner_id=? AND l.member_id=? AND l.analysis_attempted=0 AND l.status IN ('pending','unreachable') AND l.job_id IS NULL AND c.status='active' ${campaignId?'AND l.campaign_id=?':''} ORDER BY l.updated_at,l.id LIMIT ?`).bind(ownerId,memberId,...(campaignId?[campaignId]:[]),limit).all<LeadRow>();return rows.results.map(publicLead);
 }
 async function saveAnalysis(ownerId:string,memberId:string,lead:ProspectLead,analysis:AnalyzedComment,modelError?:string){
  const c=await campaign(ownerId,memberId,lead.campaignId);const next={...analysis,autoSuppressed:object(lead).autoSuppressed?1:0,...(modelError?{error:safeProspectError(modelError)}:{})};
  const saved=await db.prepare("UPDATE workbench_prospect_leads SET data_json=?,analysis_attempted=1,version=version+1,updated_at=? WHERE campaign_id=? AND id=? AND owner_id=? AND member_id=? AND version=? AND job_id IS NULL AND status IN ('pending','unreachable')").bind(JSON.stringify(next),stamp(),lead.campaignId,lead.id,ownerId,memberId,lead.version).run();
  if(saved.meta.changes&&canAutoApprove(next,c)){try{await review(ownerId,memberId,c.id,lead.id,lead.version+1,'approve',analysis.greeting,'自动策略',true);}catch(error){if(!(error instanceof DomainError))throw error;await db.prepare("UPDATE workbench_prospect_leads SET data_json=json_set(data_json,'$.error',?),updated_at=? WHERE campaign_id=? AND id=? AND job_id IS NULL").bind(error.message,stamp(),c.id,lead.id).run();}}
 }
 async function retryAnalysis(ownerId:string,memberId:string,campaignId:string){await campaign(ownerId,memberId,campaignId);await db.prepare("UPDATE workbench_prospect_leads SET analysis_attempted=0 WHERE owner_id=? AND member_id=? AND campaign_id=? AND status IN ('pending','unreachable') AND job_id IS NULL").bind(ownerId,memberId,campaignId).run();}
 async function enqueueAutomatic(ownerId:string,memberId:string){
  const d=await currentDevice(ownerId,memberId);if(!d||!online(d)||!d.authenticated)return;
  const rows=await db.prepare(`${leadSelect} JOIN workbench_prospect_campaigns c ON c.id=l.campaign_id WHERE l.owner_id=? AND l.member_id=? AND l.status='pending' AND l.job_id IS NULL AND c.status='active' AND json_extract(c.data_json,'$.reviewMode')='automatic' AND json_extract(l.data_json,'$.analysisSource')='model' AND COALESCE(json_extract(l.data_json,'$.autoSuppressed'),0)=0
   AND json_extract(l.data_json,'$.intentScore')>=json_extract(c.data_json,'$.minIntentScore')
   AND json_extract(l.data_json,'$.source')='browser' AND length(json_extract(l.data_json,'$.recipientId'))>0
   AND json_extract(l.data_json,'$.profileUrl')=('https://www.douyin.com/user/' || json_extract(l.data_json,'$.recipientId'))
   ORDER BY l.updated_at LIMIT 30`).bind(ownerId,memberId).all<LeadRow>();
  for(const row of rows.results){const lead=publicLead(row),c=await campaign(ownerId,memberId,row.campaign_id);if(!canAutoApprove(lead,c))continue;
   try{await review(ownerId,memberId,c.id,lead.id,lead.version,'approve',lead.greeting,'自动策略',true);}
   catch(error){if(!(error instanceof DomainError))throw error;const terminal=/已安排|已触达/.test(error.message);await db.prepare("UPDATE workbench_prospect_leads SET data_json=json_set(data_json,'$.error',?,'$.autoSuppressed',?),updated_at=? WHERE campaign_id=? AND id=? AND job_id IS NULL AND version=?").bind(error.message,terminal?1:0,stamp(),c.id,lead.id,lead.version).run();}
  }
 }
 return{enqueueAutomatic,connect,disconnect,authenticate,device,seen,createCampaign,campaigns,campaign,leads,jobs,setPaused,createJob,insertComments,review,claim,leased,renew,complete,pendingAnalysis,saveAnalysis,retryAnalysis};
}
