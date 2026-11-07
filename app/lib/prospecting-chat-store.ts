import {DomainError} from './domain.ts';
import {object,prospectHash,safeProspectError,text} from './prospecting-domain.ts';
import type {MemberRole} from './member-types.ts';
import type {ProspectJobRow} from './prospecting-store.ts';
import type {ProspectCapturedLead,ProspectChatAgentInput,ProspectChatConversation,ProspectChatDecision,ProspectChatMessage,ProspectChatReadResult,ProspectChatSnapshot} from './prospecting-chat-types.ts';

interface ConversationRow {id:string;owner_id:string;member_id:string;campaign_id:string;lead_id:string;sender_id:string;recipient_id:string;profile_url:string;nickname:string;mode:'agent'|'human';status:'active'|'closed';version:number;opened_at:string;last_read_at:string|null;last_snapshot_id:string|null;has_baseline:number;last_message_at:string;last_message_preview:string;handoff_reason:string|null;processing_token:string|null;processing_until:string|null;updated_at:string}
interface MessageRow {id:string;conversation_id:string;owner_id:string;member_id:string;source_key:string;direction:'inbound'|'outbound';actor:ProspectChatMessage['actor'];text:string;status:ProspectChatMessage['status'];posted_at:string|null;created_at:string;error:string|null;job_id:string|null;eligible:number;processed:number;row_order?:number;job_status?:string;job_error?:string|null;job_started_at?:string|null}
interface PoolRow {id:string;conversation_id:string;nickname:string;contact_type:ProspectCapturedLead['contactType'];contact_value:string;grade:ProspectCapturedLead['grade'];score:number;reason:string;assigned_member_id:string|null;assigned_name:string|null;status:ProspectCapturedLead['status'];updated_at:string}
interface DeviceRow {id:string;owner_id:string;member_id:string;account_id:string|null;enabled:number;authenticated:number;last_seen_at:string|null}
interface CampaignRow {id:string;owner_id:string;member_id:string;status:string;data_json:string}
const conflict=()=>new DomainError('会话已更新，请刷新后重试',409);
const publicConversation=(r:ConversationRow):ProspectChatConversation=>({id:r.id,campaignId:r.campaign_id,leadId:r.lead_id,nickname:r.nickname,recipientId:r.recipient_id,profileUrl:r.profile_url,mode:r.mode,status:r.status,version:r.version,lastMessageAt:r.last_message_at,lastMessagePreview:r.last_message_preview,...(r.handoff_reason?{handoffReason:r.handoff_reason}:{}),updatedAt:r.updated_at});
function publicMessage(r:MessageRow):ProspectChatMessage{const status=r.job_status==='running'?'sending':r.job_status==='done'?'sent':r.job_status&&['failed','unknown','cancelled'].includes(r.job_status)?r.job_status as ProspectChatMessage['status']:r.status;return{id:r.id,conversationId:r.conversation_id,direction:r.direction,text:r.text,actor:r.actor,status,...(r.posted_at?{postedAt:r.posted_at}:{}),createdAt:r.created_at,...(r.job_error||r.error?{error:r.job_error||r.error!}:{})};}
const publicPool=(r:PoolRow):ProspectCapturedLead=>({id:r.id,conversationId:r.conversation_id,nickname:r.nickname,contactType:r.contact_type,contactValue:r.contact_value,grade:r.grade,score:r.score,reason:r.reason,assignedMemberId:r.assigned_member_id,assignedName:r.assigned_name,status:r.status,updatedAt:r.updated_at});
const messageSelect='SELECT m.*,m.rowid AS row_order,j.status AS job_status,j.error AS job_error FROM workbench_prospect_messages m LEFT JOIN workbench_prospect_jobs j ON j.id=m.job_id';
const sendText=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw new DomainError('回复内容需为1至1000个字符');return value;};
const MANUAL_SYNC_INTERVAL_MS=8000;
export const isProspectChatJob=(kind:string)=>kind==='readConversation'||kind==='reply';

export function createProspectingChatStore(db:D1Database,now:()=>number=Date.now){
 const stamp=()=>new Date(now()).toISOString();
 async function member(ownerId:string,memberId:string){const row=await db.prepare("SELECT role FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1 AND role IN ('sales','manager')").bind(ownerId,memberId).first<{role:MemberRole}>();if(!row)throw new DomainError('业务账号已停用或无权操作',403);return row;}
 async function campaign(ownerId:string,memberId:string,id:string){await member(ownerId,memberId);const row=await db.prepare('SELECT * FROM workbench_prospect_campaigns WHERE id=? AND owner_id=? AND member_id=?').bind(id,ownerId,memberId).first<CampaignRow>();if(!row)throw new DomainError('获客任务不存在',404);return row;}
 async function ownConversation(ownerId:string,memberId:string,id:string){await member(ownerId,memberId);const row=await db.prepare('SELECT * FROM workbench_prospect_conversations WHERE id=? AND owner_id=? AND member_id=?').bind(id,ownerId,memberId).first<ConversationRow>();if(!row)throw new DomainError('会话不存在或无权操作',404);return row;}
 async function device(ownerId:string,memberId:string){return db.prepare('SELECT * FROM workbench_prospect_devices WHERE owner_id=? AND member_id=? AND enabled=1 ORDER BY created_at DESC,id DESC LIMIT 1').bind(ownerId,memberId).first<DeviceRow>();}
 async function ready(c:ConversationRow){const d=await device(c.owner_id,c.member_id);if(!d||!d.last_seen_at||now()-Date.parse(d.last_seen_at)>=90000)throw new DomainError('请先启动本机助手同步会话',503);if(!d.authenticated||d.account_id!==c.sender_id||d.account_id.startsWith('dy-readonly-'))throw new DomainError('当前登录账号与会话发送账号不一致',409);return d;}
 const conversationReads="owner_id=? AND member_id=? AND campaign_id=? AND lead_id=? AND sender_id=? AND kind='readConversation' AND json_extract(input_json,'$.conversationId')=?";
 const conversationReadKeys=(c:ConversationRow)=>[c.owner_id,c.member_id,c.campaign_id,c.lead_id,c.sender_id,c.id];
 async function materialize(ownerId:string,memberId:string){
  await member(ownerId,memberId);
  const rows=await db.prepare("SELECT j.*,l.data_json AS lead_json FROM workbench_prospect_jobs j JOIN workbench_prospect_leads l ON l.campaign_id=j.campaign_id AND l.id=j.lead_id WHERE j.owner_id=? AND j.member_id=? AND j.kind='send' AND j.status='done' AND NOT EXISTS (SELECT 1 FROM workbench_prospect_conversations c WHERE c.owner_id=j.owner_id AND c.sender_id=j.sender_id AND c.recipient_id=json_extract(j.input_json,'$.recipientId')) ORDER BY j.created_at,j.id LIMIT 50").bind(ownerId,memberId).all<ProspectJobRow&{lead_json:string}>();
  for(const row of rows.results){const input=object(JSON.parse(row.input_json)),lead=object(JSON.parse(row.lead_json));if(typeof input.recipientId!=='string'||typeof input.profileUrl!=='string'||!row.sender_id)continue;const id=`pcv-${(await prospectHash(`${ownerId}\0${row.sender_id}\0${input.recipientId}`)).slice(0,32)}`,opened=row.started_at??row.created_at;
   await db.prepare("INSERT INTO workbench_prospect_conversations(id,owner_id,member_id,campaign_id,lead_id,sender_id,recipient_id,profile_url,nickname,opened_at,last_message_at,last_message_preview,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,sender_id,recipient_id) DO NOTHING").bind(id,ownerId,memberId,row.campaign_id,row.lead_id,row.sender_id,input.recipientId,input.profileUrl,text(lead.nickname,100)||'抖音用户',opened,row.updated_at,text(input.message,200),stamp()).run();
   if(typeof input.message==='string')await db.prepare("INSERT INTO workbench_prospect_messages(id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,posted_at,created_at,job_id,processed) VALUES (?,?,?,?,?,'outbound',?,?,'sent',?,?,?,1) ON CONFLICT(conversation_id,source_key) DO NOTHING").bind(`pcm-${(await prospectHash(`greeting:${row.id}`)).slice(0,32)}`,id,ownerId,memberId,`greeting:${row.id}`,lead.reviewedBy==='自动策略'?'agent':'human',input.message,row.updated_at,row.updated_at,row.id).run();
  }
  await db.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='上一条回复结果待确认，正在等待可靠的外发消息记录',version=version+1,updated_at=? WHERE owner_id=? AND member_id=? AND mode='agent' AND EXISTS (SELECT 1 FROM workbench_prospect_jobs j WHERE j.kind='reply' AND j.status='unknown' AND json_extract(j.input_json,'$.conversationId')=workbench_prospect_conversations.id)").bind(stamp(),ownerId,memberId).run();
 }
 async function snapshot(ownerId:string,memberId:string,_role:MemberRole,campaignId?:string,conversationId?:string):Promise<ProspectChatSnapshot>{
  const account=await member(ownerId,memberId);const task=campaignId?await campaign(ownerId,memberId,campaignId):null;
  await materialize(ownerId,memberId);const d=await device(ownerId,memberId);
  const conversations=await db.prepare(`SELECT * FROM workbench_prospect_conversations WHERE owner_id=? AND member_id=?${campaignId?' AND campaign_id=?':''} ORDER BY last_message_at DESC,id LIMIT 100`).bind(ownerId,memberId,...(campaignId?[campaignId]:[])).all<ConversationRow>();
  let selected=conversationId?conversations.results.find(c=>c.id===conversationId):undefined;
  if(conversationId&&!selected){selected=await db.prepare(`SELECT c.* FROM workbench_prospect_conversations c WHERE c.id=? AND c.owner_id=? AND EXISTS (SELECT 1 FROM workbench_prospect_lead_pool p WHERE p.conversation_id=c.id AND p.owner_id=c.owner_id${account.role==='manager'?'':' AND p.assigned_member_id=?'})`).bind(conversationId,ownerId,...(account.role==='manager'?[]:[memberId])).first<ConversationRow>()??undefined;if(!selected)throw new DomainError('会话不存在或无权访问',404);conversations.results.push(selected);}
  const messages=selected?(await db.prepare(`${messageSelect} WHERE m.conversation_id=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 100`).bind(selected.id).all<MessageRow>()).results.reverse().map(publicMessage):[];
  const pool=(await db.prepare(`SELECT * FROM workbench_prospect_lead_pool WHERE owner_id=?${account.role==='manager'?'':' AND assigned_member_id=?'} ORDER BY score DESC,updated_at DESC,id LIMIT 200`).bind(ownerId,...(account.role==='manager'?[]:[memberId])).all<PoolRow>()).results.map(publicPool);
  const latestRead=selected?.member_id===memberId?await db.prepare(`SELECT status,updated_at,error FROM workbench_prospect_jobs WHERE ${conversationReads} ORDER BY updated_at DESC,rowid DESC LIMIT 1`).bind(...conversationReadKeys(selected)).first<Pick<ProspectJobRow,'status'|'updated_at'|'error'>>():null;
  const sync=latestRead&&selected?{conversationId:selected.id,status:latestRead.status,updatedAt:latestRead.updated_at,...(latestRead.error?{error:latestRead.error}:{})}:undefined;
  return{enabled:!!task&&object(JSON.parse(task.data_json)).chatEnabled===true,online:!!d?.last_seen_at&&now()-Date.parse(d.last_seen_at)<90000&&!!d.authenticated,conversations:conversations.results.map(publicConversation),messages,pool,...(sync?{sync}:{})};
 }
 function cancelQueued(conversationId:string,guard:string,values:unknown[],actor?:'agent'|'human'){
  return[
   db.prepare(`UPDATE workbench_prospect_jobs SET status='cancelled',active_key=NULL,error='会话控制或新消息已改变，原回复已取消',updated_at=? WHERE kind='reply' AND status='queued' AND json_extract(input_json,'$.conversationId')=?${actor?" AND json_extract(input_json,'$.actor')=?":''} AND EXISTS (${guard})`).bind(stamp(),conversationId,...(actor?[actor]:[]),...values),
   db.prepare(`UPDATE workbench_prospect_messages SET status='cancelled' WHERE conversation_id=? AND job_id IN (SELECT id FROM workbench_prospect_jobs WHERE status='cancelled') AND EXISTS (${guard})`).bind(conversationId,...values),
  ];
 }
 async function settings(ownerId:string,memberId:string,campaignId:string,enabled:boolean){
  await campaign(ownerId,memberId,campaignId);if(typeof enabled!=='boolean')throw new DomainError('会话开关参数无效');const time=stamp();
  const statements=[db.prepare("UPDATE workbench_prospect_campaigns SET data_json=json_set(data_json,'$.chatEnabled',json(?)),updated_at=? WHERE id=? AND owner_id=? AND member_id=?").bind(JSON.stringify(enabled),time,campaignId,ownerId,memberId)];
  if(!enabled){statements.push(db.prepare("UPDATE workbench_prospect_jobs SET status='cancelled',active_key=NULL,error='会话同步已关闭',updated_at=? WHERE owner_id=? AND member_id=? AND campaign_id=? AND kind IN ('readConversation','reply') AND status='queued'").bind(time,ownerId,memberId,campaignId),db.prepare("UPDATE workbench_prospect_messages SET status='cancelled' WHERE owner_id=? AND member_id=? AND job_id IN (SELECT id FROM workbench_prospect_jobs WHERE status='cancelled')").bind(ownerId,memberId),db.prepare('UPDATE workbench_prospect_conversations SET processing_token=NULL,processing_until=NULL,version=version+1,updated_at=? WHERE campaign_id=? AND owner_id=? AND member_id=?').bind(time,campaignId,ownerId,memberId));}
  await db.batch(statements);await materialize(ownerId,memberId);
 }
 async function control(ownerId:string,memberId:string,id:string,version:number,mode:'agent'|'human'){
  const c=await ownConversation(ownerId,memberId,id);if(c.version!==version||c.status!=='active')throw conflict();const token=crypto.randomUUID(),time=stamp(),guard='SELECT 1 FROM workbench_prospect_conversations WHERE id=? AND processing_token=?';
  if(mode==='agent'&&await db.prepare("SELECT id FROM workbench_prospect_jobs WHERE kind='reply' AND status='unknown' AND json_extract(input_json,'$.conversationId')=? LIMIT 1").bind(id).first())throw new DomainError('上一条回复结果待确认，可靠同步核实之前不能恢复自动回复',409);
  const results=await db.batch([
   db.prepare('UPDATE workbench_prospect_conversations SET mode=?,handoff_reason=?,version=version+1,processing_token=?,processing_until=NULL,updated_at=? WHERE id=? AND owner_id=? AND member_id=? AND version=? AND status=\'active\'').bind(mode,mode==='human'?'已由销售接管':null,token,time,id,ownerId,memberId,version),
   ...cancelQueued(id,guard,[id,token]),
   db.prepare('UPDATE workbench_prospect_conversations SET processing_token=NULL WHERE id=? AND processing_token=?').bind(id,token),
  ]);if(!results[0].meta.changes)throw conflict();
 }
 const takeover=(ownerId:string,memberId:string,id:string,version:number)=>control(ownerId,memberId,id,version,'human');
 const resume=(ownerId:string,memberId:string,id:string,version:number)=>control(ownerId,memberId,id,version,'agent');
 function replyStatements(c:ConversationRow,d:DeviceRow,message:string,actor:'agent'|'human',guard:string,values:unknown[],metadata:unknown={}){
  const jobId=`pj-${crypto.randomUUID()}`,replyId=`pcm-${crypto.randomUUID()}`,time=stamp();
  const input={senderAccountId:c.sender_id,recipientId:c.recipient_id,profileUrl:c.profile_url,message,replyId,expectedSnapshotId:c.last_snapshot_id,conversationId:c.id,actor};
  return{jobId,statements:[
   db.prepare(`INSERT INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,result_json,active_key,sender_id,created_at,updated_at) SELECT ?,?,?,?,?,?,'reply','queued',?,?,?,?,?,? WHERE EXISTS (${guard}) AND EXISTS (SELECT 1 FROM workbench_prospect_devices WHERE id=? AND enabled=1 AND authenticated=1 AND account_id=?)`).bind(jobId,c.owner_id,c.member_id,d.id,c.campaign_id,c.lead_id,JSON.stringify(input),JSON.stringify(metadata),`chat-reply:${c.id}`,c.sender_id,time,time,...values,d.id,c.sender_id),
   db.prepare("INSERT INTO workbench_prospect_messages(id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,created_at,job_id,processed) SELECT ?,?,?,?,?,'outbound',?,?,'queued',?,?,1 WHERE EXISTS (SELECT 1 FROM workbench_prospect_jobs WHERE id=?)").bind(replyId,c.id,c.owner_id,c.member_id,`reply:${replyId}`,actor,message,time,jobId,jobId),
  ]};
 }
 async function reply(ownerId:string,memberId:string,id:string,version:number,message:string){
  sendText(message);const c=await ownConversation(ownerId,memberId,id);if(c.version!==version||c.status!=='active')throw conflict();const task=await campaign(ownerId,memberId,c.campaign_id);
  if(task.status!=='active'||object(JSON.parse(task.data_json)).chatEnabled!==true||!c.last_snapshot_id)throw new DomainError('请先启用并完成一次会话同步',409);
  if(await db.prepare("SELECT id FROM workbench_prospect_jobs WHERE kind='reply' AND status IN ('running','unknown') AND json_extract(input_json,'$.conversationId')=? LIMIT 1").bind(id).first())throw new DomainError('上一条回复仍在执行或结果待确认，请等待会话同步后再回复',409);
  const d=await ready(c),token=crypto.randomUUID(),guard='SELECT 1 FROM workbench_prospect_conversations WHERE id=? AND processing_token=?';
  const queued=replyStatements(c,d,message,'human',guard,[id,token]);
  const results=await db.batch([
   db.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='已由销售接管',version=version+1,processing_token=?,processing_until=NULL,updated_at=? WHERE id=? AND owner_id=? AND member_id=? AND version=? AND status='active'").bind(token,stamp(),id,ownerId,memberId,version),
   ...cancelQueued(id,guard,[id,token]),...queued.statements,
   db.prepare('UPDATE workbench_prospect_conversations SET processing_token=NULL WHERE id=? AND processing_token=?').bind(id,token),
  ]);if(!results[0].meta.changes)throw conflict();
 }
 async function queueRead(c:ConversationRow,d:DeviceRow,manual?:{observeOnly:boolean}){
  const time=stamp(),input={senderAccountId:c.sender_id,recipientId:c.recipient_id,profileUrl:c.profile_url,conversationId:c.id,limit:80,...(manual?{manualSync:true,observeOnly:manual.observeOnly}:{})};
  const cooldown=manual?`AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs WHERE ${conversationReads} AND updated_at>?)`:'';
  const recent=manual?[...conversationReadKeys(c),new Date(now()-MANUAL_SYNC_INTERVAL_MS).toISOString()]:[];
  const queued=await db.prepare(`INSERT OR IGNORE INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,active_key,sender_id,created_at,updated_at)
   SELECT ?,?,?,?,?,?,'readConversation','queued',?,?,?,?,?
   WHERE EXISTS (SELECT 1 FROM workbench_prospect_campaigns p JOIN workbench_prospect_devices d ON d.owner_id=p.owner_id AND d.member_id=p.member_id
     JOIN workbench_member_accounts m ON m.account_id=p.member_id AND m.owner_id=p.owner_id
     WHERE p.id=? AND p.status='active' AND d.id=? AND d.enabled=1 AND d.authenticated=1 AND d.account_id=?
       AND m.enabled=1 AND m.role IN ('sales','manager') AND (?=1 OR json_extract(p.data_json,'$.chatEnabled')=1))
   ${cooldown}`).bind(`pj-${crypto.randomUUID()}`,c.owner_id,c.member_id,d.id,c.campaign_id,c.lead_id,JSON.stringify(input),`chat-read:${c.id}`,c.sender_id,time,time,c.campaign_id,d.id,c.sender_id,manual?1:0,...recent).run();
  return Boolean(queued.meta.changes);
 }
 async function sync(ownerId:string,memberId:string,campaignId:string,conversationId:string){
  const c=await ownConversation(ownerId,memberId,conversationId);
  if(c.campaign_id!==campaignId)throw new DomainError('当前任务中不存在该会话',404);
  const task=await campaign(ownerId,memberId,campaignId);
  if(task.status!=='active')throw new DomainError('获客任务已暂停，请恢复后同步',409);
  if(c.status!=='active')throw new DomainError('该会话已关闭，无法同步',409);
  const d=await ready(c),observeOnly=object(JSON.parse(task.data_json)).chatEnabled!==true;
  if(await queueRead(c,d,{observeOnly}))return true;
  await db.prepare("UPDATE workbench_prospect_jobs SET input_json=json_set(input_json,'$.manualSync',json('true'),'$.observeOnly',json(?)) WHERE active_key=? AND device_id=? AND kind='readConversation' AND status='queued' AND json_type(input_json,'$.manualSync') IS NULL").bind(String(observeOnly),`chat-read:${c.id}`,d.id).run();
  return false;
 }
 async function hasQueuedManualSync(deviceId:string){
  return Boolean(await db.prepare("SELECT 1 FROM workbench_prospect_jobs WHERE device_id=? AND status='queued' AND kind='readConversation' AND json_extract(input_json,'$.manualSync')=1 LIMIT 1").bind(deviceId).first());
 }
 async function schedule(deviceId:string){
  const d=await db.prepare("SELECT d.* FROM workbench_prospect_devices d JOIN workbench_member_accounts m ON m.account_id=d.member_id AND m.owner_id=d.owner_id WHERE d.id=? AND d.enabled=1 AND d.authenticated=1 AND m.enabled=1 AND m.role IN ('sales','manager')").bind(deviceId).first<DeviceRow>();if(!d?.account_id||d.account_id.startsWith('dy-readonly-'))return;
  await materialize(d.owner_id,d.member_id);
  const c=await db.prepare("SELECT c.* FROM workbench_prospect_conversations c JOIN workbench_prospect_campaigns p ON p.id=c.campaign_id WHERE c.owner_id=? AND c.member_id=? AND c.sender_id=? AND c.status='active' AND p.status='active' AND json_extract(p.data_json,'$.chatEnabled')=1 AND (c.last_read_at IS NULL OR c.last_read_at<=?) AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs j WHERE j.active_key=('chat-read:'||c.id)) ORDER BY COALESCE(c.last_read_at,''),c.id LIMIT 1").bind(d.owner_id,d.member_id,d.account_id,new Date(now()-60000).toISOString()).first<ConversationRow>();if(!c)return;
  await queueRead(c,d);
 }
 async function assertJob(row:ProspectJobRow){
  const input=object(JSON.parse(row.input_json));const c=await ownConversation(row.owner_id,row.member_id,String(input.conversationId));const p=await campaign(row.owner_id,row.member_id,c.campaign_id);
  const manualRead=row.kind==='readConversation'&&input.manualSync===true;
  if(c.status!=='active'||p.status!=='active'||(!manualRead&&object(JSON.parse(p.data_json)).chatEnabled!==true)||c.sender_id!==row.sender_id||input.senderAccountId!==c.sender_id||input.recipientId!==c.recipient_id||input.profileUrl!==c.profile_url)throw new DomainError('会话状态或身份已改变，请停止执行',409);
  if(row.kind==='reply'&&(input.actor!==c.mode&&!(input.actor==='human'&&c.mode==='human')||input.expectedSnapshotId!==c.last_snapshot_id))throw new DomainError('会话已被接管或收到新消息，请停止原回复',409);
  return c;
 }
 function normalizeRead(row:ProspectJobRow,value:unknown):ProspectChatReadResult{
  const v=object(value),input=object(JSON.parse(row.input_json));
  if(v.senderAccountId!==row.sender_id||v.recipientId!==input.recipientId)throw new DomainError('会话读取身份与绑定账号不一致',409);
  if(typeof v.observedAt!=='string'||!Number.isFinite(Date.parse(v.observedAt))||Math.abs(Date.parse(v.observedAt)-now())>300000||typeof v.snapshotId!=='string'||!v.snapshotId||v.snapshotId.length>256||typeof v.reliable!=='boolean'||v.covered!==undefined&&typeof v.covered!=='boolean'||!Array.isArray(v.messages)||v.messages.length>100)throw new DomainError('会话读取结果格式不正确');
  const ids=new Set<string>();const messages=v.messages.map(raw=>{const m=object(raw);if(typeof m.id!=='string'||!m.id||m.id.length>256||ids.has(m.id)||!['inbound','outbound'].includes(String(m.direction))||typeof m.text!=='string'||!m.text.trim()||m.text.length>4000)throw new DomainError('会话消息格式不正确');ids.add(m.id);if(m.postedAt!==undefined&&(typeof m.postedAt!=='string'||!Number.isFinite(Date.parse(m.postedAt))||Date.parse(m.postedAt)>Date.parse(v.observedAt as string)+300000))throw new DomainError('会话消息时间无效');return{id:m.id,direction:m.direction as 'inbound'|'outbound',text:m.text,...(typeof m.postedAt==='string'?{postedAt:new Date(m.postedAt).toISOString()}:{})};});
  return{senderAccountId:String(v.senderAccountId),recipientId:String(v.recipientId),observedAt:new Date(v.observedAt).toISOString(),snapshotId:v.snapshotId,reliable:v.reliable,...(typeof v.covered==='boolean'?{covered:v.covered}:{}),messages};
 }
 async function complete(row:ProspectJobRow,result:unknown,error?:string){
  const input=object(JSON.parse(row.input_json)),c=await ownConversation(row.owner_id,row.member_id,String(input.conversationId));const guard="SELECT 1 FROM workbench_prospect_jobs WHERE id=? AND status='running' AND lease_hash=?",values=[row.id,row.lease_hash],time=stamp();
  if(row.kind==='reply'){
   const value=object(result);if(!error&&!['submitted','failed','unknown'].includes(String(value.outcome)))throw new DomainError('会话回复结果格式不正确');const status=error?'unknown':value.outcome==='submitted'?'done':String(value.outcome),problem=safeProspectError(error||value.error);
   const metadata=row.result_json?object(JSON.parse(row.result_json)):{};
   await db.batch([
    db.prepare(`UPDATE workbench_prospect_messages SET status=?,error=? WHERE job_id=? AND EXISTS (${guard})`).bind(status==='done'?'sent':status,problem||null,row.id,...values),
    db.prepare(`UPDATE workbench_prospect_conversations SET mode=CASE WHEN ?='done' THEN mode ELSE 'human' END,handoff_reason=CASE WHEN ?='done' THEN handoff_reason ELSE ? END,last_message_at=CASE WHEN ?='done' THEN ? ELSE last_message_at END,last_message_preview=CASE WHEN ?='done' THEN ? ELSE last_message_preview END,version=version+1,updated_at=? WHERE id=? AND EXISTS (${guard})`).bind(status,status,problem||'回复未能确认，已转交销售',status,time,status,text(input.message,200),time,c.id,...values),
    db.prepare("UPDATE workbench_prospect_jobs SET status=?,result_json=?,error=?,active_key=NULL,updated_at=? WHERE id=? AND status='running' AND lease_hash=?").bind(status,JSON.stringify({...metadata,outcome:status==='done'?'submitted':status,summary:status==='done'?'会话回复已提交，未验证送达':status==='unknown'?'会话回复结果待确认':'会话回复未提交',evidence:text(value.evidence,500)}),problem||null,time,...values),
   ]);return;
  }
  const task=await campaign(row.owner_id,row.member_id,c.campaign_id);
  const automatic=task.status==='active'&&object(JSON.parse(task.data_json)).chatEnabled===true&&input.observeOnly!==true;
  if(error){await db.batch([
   ...(automatic?[db.prepare(`UPDATE workbench_prospect_conversations SET mode='human',handoff_reason=?,last_read_at=?,version=version+1,processing_token=NULL,processing_until=NULL,updated_at=? WHERE id=? AND EXISTS (${guard})`).bind(`会话同步暂时失败：${safeProspectError(error)||'请稍后重新同步'}`,time,time,c.id,...values)]:[]),
   db.prepare("UPDATE workbench_prospect_jobs SET status='failed',error=?,active_key=NULL,updated_at=? WHERE id=? AND status='running' AND lease_hash=?").bind(safeProspectError(error),time,...values),
  ]);return;}
  const read=normalizeRead(row,result);if(c.last_read_at&&read.observedAt<c.last_read_at)throw new DomainError('会话读取结果已过期',409);
  const existing=(await db.prepare('SELECT m.*,j.status AS job_status,j.started_at AS job_started_at FROM workbench_prospect_messages m LEFT JOIN workbench_prospect_jobs j ON j.id=m.job_id WHERE m.conversation_id=?').bind(c.id).all<MessageRow>()).results;const bySource=new Map(existing.map(m=>[m.source_key,m]));
  const statements:D1PreparedStatement[]=[];
  const greeting=existing.find(m=>m.source_key.startsWith('greeting:'));
  const anchors=greeting?read.messages.flatMap((m,index)=>m.direction==='outbound'&&m.text===greeting.text?[index]:[]):[];
  const anchor=anchors.length===1?anchors[0]:-1;
  for(const [index,m] of read.messages.entries()){const previous=bySource.get(m.id);if(previous){if(previous.direction!==m.direction||previous.text!==m.text)throw new DomainError('已记录消息的身份或正文发生变化，请重新同步',409);continue;}
   const localMatches=m.direction==='outbound'?existing.filter(local=>local.direction==='outbound'&&local.text===m.text&&(local.source_key.startsWith('reply:')||local.source_key.startsWith('greeting:'))&&((local.status==='sent'||local.job_status==='done')&&(!m.postedAt||Math.abs(Date.parse(m.postedAt)-Date.parse(local.created_at))<300000)||local.job_status==='unknown'&&m.postedAt&&local.job_started_at&&Date.parse(m.postedAt)>=Date.parse(local.job_started_at))):[];
   if(localMatches.length===1&&read.messages.filter(other=>other.direction==='outbound'&&other.text===m.text).length===1){const local=localMatches[0];statements.push(db.prepare(`UPDATE workbench_prospect_messages SET source_key=?,posted_at=COALESCE(?,posted_at),status='sent' WHERE id=? AND EXISTS (${guard})`).bind(m.id,m.postedAt??null,local.id,...values));continue;}
   const id=`pcm-${(await prospectHash(`${c.id}\0${m.id}`)).slice(0,32)}`;
   const eligible=automatic&&read.reliable&&m.direction==='inbound'&&(m.postedAt?Date.parse(m.postedAt)>=Date.parse(c.opened_at):!!c.has_baseline||anchor>=0&&index>anchor);
   statements.push(db.prepare(`INSERT INTO workbench_prospect_messages(id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,posted_at,created_at,eligible) SELECT ?,?,?,?,?,?,?,?,'received',?,?,? WHERE EXISTS (${guard}) ON CONFLICT(conversation_id,source_key) DO NOTHING`).bind(id,c.id,c.owner_id,c.member_id,m.id,m.direction,m.direction==='inbound'?'customer':'human',m.text,m.postedAt??null,read.observedAt,eligible?1:0,...values));
  }
  const changed=read.snapshotId!==c.last_snapshot_id;const last=read.messages.at(-1);
  if(changed)statements.push(...cancelQueued(c.id,guard,values));
  // Matching outgoing evidence resolves an ambiguous reply without another send.
  if(read.reliable)for(const m of read.messages.filter(m=>m.direction==='outbound'&&!bySource.has(m.id)&&m.postedAt)){
   statements.push(db.prepare(`UPDATE workbench_prospect_jobs SET status='done',result_json=json_set(COALESCE(result_json,'{}'),'$.outcome','submitted','$.summary','后续会话同步已观察到相同外发消息'),error=NULL,active_key=NULL,updated_at=? WHERE kind='reply' AND status='unknown' AND json_extract(input_json,'$.conversationId')=? AND json_extract(input_json,'$.message')=? AND started_at<=? AND EXISTS (${guard})`).bind(time,c.id,m.text,m.postedAt!,...values));
  }
  statements.push(db.prepare(`UPDATE workbench_prospect_conversations SET last_read_at=?,last_snapshot_id=?,has_baseline=CASE WHEN ?=1 THEN 1 ELSE has_baseline END,last_message_at=?,last_message_preview=?,mode=CASE WHEN ?=1 THEN 'human' ELSE mode END,handoff_reason=CASE WHEN ?=1 THEN '会话读取尚不可靠，已暂停自动回复' WHEN ?=1 AND (handoff_reason IN ('会话读取尚不可靠，已暂停自动回复','会话读取失败，已转交销售','会话面板未打开或需要人工操作，未发送。') OR handoff_reason LIKE '会话同步暂时失败：%') THEN '会话已恢复同步，可继续人工回复' ELSE handoff_reason END,version=version+?,processing_token=CASE WHEN ?=1 THEN NULL ELSE processing_token END,processing_until=CASE WHEN ?=1 THEN NULL ELSE processing_until END,updated_at=? WHERE id=? AND EXISTS (${guard})`).bind(read.observedAt,read.reliable||read.covered===true?read.snapshotId:null,read.reliable?1:0,last?.postedAt??(last?read.observedAt:c.last_message_at),last?text(last.text,200):c.last_message_preview,automatic&&!read.reliable?1:0,automatic&&!read.reliable?1:0,read.reliable?1:0,changed?1:0,changed?1:0,changed?1:0,time,c.id,...values));
  statements.push(db.prepare("UPDATE workbench_prospect_jobs SET status='done',result_json=?,active_key=NULL,updated_at=? WHERE id=? AND status='running' AND lease_hash=?").bind(JSON.stringify({summary:read.reliable?`已同步${read.messages.length}条可核实消息`:'读取结果未通过可靠性检查，未启动自动回复'}),time,...values));
  await db.batch(statements);
 }
 async function captureStatement(c:ConversationRow,pending:MessageRow[],decision:ProspectChatDecision,guard:string,values:unknown[]){
  const lead=decision.lead;if(!lead||!['phone','wechat','email'].includes(lead.contactType)||typeof lead.contactValue!=='string'||!lead.contactValue||lead.contactValue.length>120||!pending.some(inbound=>inbound.text.includes(lead.contactValue))||!Number.isFinite(lead.score)||lead.score<0||lead.score>100||!['high','medium','low'].includes(lead.grade))return null;
  const canonical=lead.contactType==='email'?lead.contactValue.toLowerCase():lead.contactType==='phone'?lead.contactValue.replace(/\D/g,''):lead.contactValue;
  if(lead.contactType==='phone'&&!/^\d{7,15}$/.test(canonical)||lead.contactType==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.contactValue))return null;
  const contactKey=await prospectHash(`${lead.contactType}\0${canonical}`),time=stamp();
  const assignee="SELECT m.account_id FROM workbench_member_accounts m WHERE m.owner_id=? AND m.enabled=1 AND m.role='sales' ORDER BY CASE WHEN EXISTS (SELECT 1 FROM workbench_prospect_lead_pool same WHERE same.owner_id=m.owner_id AND same.conversation_id=? AND same.assigned_member_id=m.account_id) THEN 0 ELSE 1 END,(SELECT COUNT(DISTINCT p.conversation_id) FROM workbench_prospect_lead_pool p WHERE p.owner_id=m.owner_id AND p.assigned_member_id=m.account_id AND p.status='assigned'),m.account_id LIMIT 1";
  return db.prepare(`INSERT INTO workbench_prospect_lead_pool(id,owner_id,conversation_id,contact_key,contact_type,contact_value,nickname,score,grade,reason,assigned_member_id,assigned_name,status,created_at,updated_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,s.account_id,s.display_name,CASE WHEN s.account_id IS NULL THEN 'unassigned' ELSE 'assigned' END,?,? FROM (SELECT 1) LEFT JOIN workbench_member_accounts s ON s.account_id=(${assignee}) AND s.owner_id=? WHERE EXISTS (${guard})
   ON CONFLICT(owner_id,conversation_id,contact_key) DO UPDATE SET score=excluded.score,grade=excluded.grade,reason=excluded.reason,assigned_member_id=excluded.assigned_member_id,assigned_name=excluded.assigned_name,status=excluded.status,updated_at=excluded.updated_at`).bind(`pcl-${crypto.randomUUID()}`,c.owner_id,c.id,contactKey,lead.contactType,lead.contactValue,c.nickname,Math.round(lead.score),lead.grade,text(lead.reason,500),time,time,c.owner_id,c.id,c.owner_id,...values);
 }
 async function processOne(ownerId:string,memberId:string,origin:string,decide?: (ownerId:string,origin:string,input:ProspectChatAgentInput)=>Promise<ProspectChatDecision>):Promise<boolean>{
  await member(ownerId,memberId);const token=crypto.randomUUID(),time=stamp();
  const c=await db.prepare("UPDATE workbench_prospect_conversations SET processing_token=?,processing_until=? WHERE id=(SELECT c.id FROM workbench_prospect_conversations c WHERE c.owner_id=? AND c.member_id=? AND c.status='active' AND (c.processing_token IS NULL OR c.processing_until<=?) AND EXISTS (SELECT 1 FROM workbench_prospect_messages m WHERE m.conversation_id=c.id AND m.direction='inbound' AND m.eligible=1 AND m.processed=0) AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs j WHERE j.kind='reply' AND j.status IN ('queued','running') AND json_extract(j.input_json,'$.conversationId')=c.id) ORDER BY c.last_message_at,c.id LIMIT 1) RETURNING *").bind(token,new Date(now()+60000).toISOString(),ownerId,memberId,time).first<ConversationRow>();if(!c)return false;
  const unresolved=!!await db.prepare("SELECT id FROM workbench_prospect_jobs WHERE kind='reply' AND status='unknown' AND json_extract(input_json,'$.conversationId')=? LIMIT 1").bind(c.id).first();
  const pending=(await db.prepare(`${messageSelect} WHERE m.conversation_id=? AND m.direction='inbound' AND m.eligible=1 AND m.processed=0 ORDER BY m.created_at,m.rowid LIMIT 100`).bind(c.id).all<MessageRow>()).results;
  const inbound=pending.at(-1);
  if(!inbound){await db.prepare('UPDATE workbench_prospect_conversations SET processing_token=NULL,processing_until=NULL WHERE id=? AND processing_token=?').bind(c.id,token).run();return false;}
  const task=await campaign(ownerId,memberId,c.campaign_id),campaignData=object(JSON.parse(task.data_json));const history=(await db.prepare(`${messageSelect} WHERE m.conversation_id=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 40`).bind(c.id).all<MessageRow>()).results.reverse().map(publicMessage);
  let decision:ProspectChatDecision;
  try{decision=decide?await decide(ownerId,origin,{campaign:{name:String(campaignData.name||''),requirements:String(campaignData.requirements||''),minIntentScore:Number(campaignData.minIntentScore||70)},conversation:{nickname:c.nickname,mode:!unresolved&&campaignData.chatEnabled===true&&task.status==='active'?c.mode:'human'},messages:history,inbound:{id:inbound.id,text:inbound.text},pending:pending.map(m=>({id:m.id,text:m.text}))}):{action:'handoff',reason:'尚未配置可用的会话模型，已转交销售'};if(!decision||!['reply','handoff','wait'].includes(decision.action))throw new Error('invalid decision');if(decision.action==='reply')sendText(decision.reply);}
  catch{decision={action:'handoff',reason:'会话判断暂时不可用，原消息已保留并转交销售'};}
  const guard='SELECT 1 FROM workbench_prospect_conversations WHERE id=? AND version=? AND processing_token=?',values=[c.id,c.version,token],statements:D1PreparedStatement[]=[];
  const captured=await captureStatement(c,pending,decision,guard,values);if(captured)statements.push(captured);
  let replyJobId:string|undefined;
  if(!unresolved&&decision.action==='reply'&&c.mode==='agent'&&task.status==='active'&&campaignData.chatEnabled===true&&c.last_snapshot_id){try{const d=await ready(c);const queued=replyStatements(c,d,decision.reply!,'agent',guard,values,{evidenceIds:decision.evidenceIds?.filter(id=>typeof id==='string').slice(0,20),decisionReason:text(decision.reason,500)});replyJobId=queued.jobId;statements.push(...queued.statements);}catch{decision={...decision,action:'handoff',reason:'助手离线或发送账号已改变，回复已转交销售'};}}
  statements.push(db.prepare(`UPDATE workbench_prospect_messages SET processed=1 WHERE conversation_id=? AND direction='inbound' AND eligible=1 AND processed=0 AND rowid<=? AND EXISTS (${guard})`).bind(c.id,inbound.row_order,...values));
  const handoff=decision.action==='handoff'||unresolved;if(unresolved)decision.reason='上一条回复结果待确认，已保留人工接管';
  statements.push(db.prepare(`UPDATE workbench_prospect_conversations SET mode=CASE WHEN ?=1 THEN 'human' ELSE mode END,handoff_reason=CASE WHEN ?=1 THEN ? ELSE handoff_reason END,version=version+1,processing_token=NULL,processing_until=NULL,updated_at=? WHERE id=? AND version=? AND processing_token=?`).bind(handoff?1:0,handoff?1:0,text(safeProspectError(decision.reason),500)||'已转交销售',stamp(),...values));
  try{const results=await db.batch(statements);if(!results.at(-1)?.meta.changes)return true;
   if(replyJobId){const queued=await db.prepare('SELECT id FROM workbench_prospect_jobs WHERE id=?').bind(replyJobId).first();if(!queued)await db.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='助手身份已改变，未排队回复',version=version+1 WHERE id=?").bind(c.id).run();}
   return true;
  }catch(error){await db.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='回复未能可靠排队，已转交销售',processing_token=NULL,processing_until=NULL,version=version+1,updated_at=? WHERE id=? AND processing_token=?").bind(stamp(),c.id,token).run();throw error;}
 }
 return{materialize,snapshot,settings,takeover,resume,reply,sync,hasQueuedManualSync,schedule,assertJob,complete,processOne};
}
