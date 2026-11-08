import {knowledgeDepartmentForSalesId} from './knowledge-department-scope.ts';
import {isQuietProspectAcknowledgement} from './prospecting-chat-agent.ts';
import {createProspectMemoryStore} from './prospecting-memory-store.ts';
import {projectTaskMemory,understandTaskMemory} from './prospecting-memory.ts';
import type {TaskMemoryView,TaskMemoryState,TaskMemoryMessage,TaskMemoryOptions,TaskMemoryEdit} from './prospecting-memory-types.ts';
import {DomainError} from './domain.ts';
import {normalizeChatPolicy,withinChatHours,normalizeChatMemory,isChatOptOut} from './prospecting-chat-policy.ts';
import {object,prospectHash,safeProspectError,text} from './prospecting-domain.ts';
import type {MemberRole} from './member-types.ts';
import type {ProspectJobRow} from './prospecting-store.ts';
import type {ProspectCapturedLead,ProspectChatAgentInput,ProspectChatConversation,ProspectChatDecision,ProspectChatMessage,ProspectChatReadResult,ProspectChatSnapshot} from './prospecting-chat-types.ts';

interface ConversationRow {id:string;owner_id:string;member_id:string;campaign_id:string;lead_id:string;sender_id:string;recipient_id:string;profile_url:string;nickname:string;mode:'agent'|'human';status:'active'|'closed';version:number;opened_at:string;last_read_at:string|null;last_snapshot_id:string|null;has_baseline:number;last_message_at:string;last_message_preview:string;handoff_reason:string|null;memory_json:string;close_reason:string|null;processing_token:string|null;processing_until:string|null;updated_at:string;contact_captured?:number;last_synced_at?:string|null}
interface MessageRow {id:string;conversation_id:string;owner_id:string;member_id:string;source_key:string;direction:'inbound'|'outbound';actor:ProspectChatMessage['actor'];text:string;content_type?:'text'|'image';status:ProspectChatMessage['status'];posted_at:string|null;created_at:string;error:string|null;job_id:string|null;eligible:number;processed:number;row_order?:number;job_status?:string;job_error?:string|null;job_started_at?:string|null;job_result_json?:string|null}
interface PoolRow {id:string;conversation_id:string;nickname:string;contact_type:ProspectCapturedLead['contactType'];contact_value:string;grade:ProspectCapturedLead['grade'];score:number;reason:string;assigned_member_id:string|null;assigned_name:string|null;status:ProspectCapturedLead['status'];updated_at:string}
interface DeviceRow {id:string;owner_id:string;member_id:string;account_id:string|null;enabled:number;authenticated:number;last_seen_at:string|null}
interface CampaignRow {id:string;owner_id:string;member_id:string;status:string;data_json:string}
const conflict=()=>new DomainError('会话已更新，请刷新后重试',409);
const publicConversation=(r:ConversationRow):ProspectChatConversation=>({id:r.id,campaignId:r.campaign_id,leadId:r.lead_id,nickname:r.nickname,recipientId:r.recipient_id,profileUrl:r.profile_url,mode:r.mode,status:r.status,version:r.version,lastMessageAt:r.last_message_at,lastMessagePreview:r.last_message_preview,...(r.last_synced_at?{lastSyncedAt:r.last_synced_at}:{}),...(r.handoff_reason?{handoffReason:r.handoff_reason}:{}),memory:{...normalizeChatMemory(r.memory_json),contactCaptured:normalizeChatMemory(r.memory_json).contactCaptured||!!r.contact_captured},...(r.close_reason?{closeReason:r.close_reason}:{}),updatedAt:r.updated_at});
const retryableResult=(value:unknown)=>{const v=object(value);return v.outcome==='failed'&&v.retryable===true&&v.errorCode==='ACCOUNT_VERIFICATION_PENDING';};
function publicMessage(r:MessageRow):ProspectChatMessage{
 const metadata=r.job_result_json?object(JSON.parse(r.job_result_json)):{};
 const retryable=r.job_status==='failed'&&retryableResult(metadata);
 const status=r.status==='waiting'||r.status==='cancelled'?r.status:r.job_status==='running'?'sending':r.job_status==='done'?'sent':r.job_status&&['failed','unknown','cancelled'].includes(r.job_status)?r.job_status as ProspectChatMessage['status']:r.status;
 return{id:r.id,conversationId:r.conversation_id,direction:r.direction,text:r.text,...(r.content_type==='image'?{contentType:'image' as const}:{}),actor:r.actor,status,...(r.posted_at?{postedAt:r.posted_at}:{}),createdAt:r.created_at,...(r.job_error||r.error?{error:r.job_error||r.error!}:{}),...(retryable?{retryable:true,...(typeof metadata.retryAt==='string'?{retryAt:metadata.retryAt}:{}),...(typeof metadata.retryExhausted==='boolean'?{retryExhausted:metadata.retryExhausted}:{})}:{})};
}
const publicPool=(r:PoolRow):ProspectCapturedLead=>({id:r.id,conversationId:r.conversation_id,nickname:r.nickname,contactType:r.contact_type,contactValue:r.contact_value,grade:r.grade,score:r.score,reason:r.reason,assignedMemberId:r.assigned_member_id,assignedName:r.assigned_name,status:r.status,updatedAt:r.updated_at});
const capturedContactSql="EXISTS (SELECT 1 FROM workbench_prospect_lead_pool captured WHERE captured.owner_id=c.owner_id AND captured.conversation_id=c.id) AS contact_captured";
const lastSyncedSql="(SELECT json_extract(synced.result_json,'$.observedAt') FROM workbench_prospect_jobs synced WHERE synced.owner_id=c.owner_id AND synced.member_id=c.member_id AND synced.sender_id=c.sender_id AND synced.kind='readConversation' AND synced.status='done' AND json_extract(synced.input_json,'$.conversationId')=c.id AND json_extract(synced.result_json,'$.reliable')=1 ORDER BY json_extract(synced.result_json,'$.observedAt') DESC LIMIT 1) AS last_synced_at";
const RESUME_PENDING='已恢复AI，等待同步核实最新未回复消息';
const temporaryReadyReasons=['本机助手未连接，请启动本机助手并连接抖音后重新同步','本机助手暂未核实当前账号，请在助手中完成账号核验后重新同步'];
const technicalReadReasons=[...temporaryReadyReasons,'会话读取尚不可靠，已暂停自动回复','会话读取尚不可靠，已暂停自动回复；请稍后重新同步，核实消息后再继续。','会话读取失败，已转交销售','会话面板未打开或需要人工操作，未发送。','会话已恢复同步，可继续人工回复'];
const isTechnicalReadPause=(reason:string|null)=>!!reason&&(technicalReadReasons.includes(reason)||reason===RESUME_PENDING||reason.startsWith('会话同步暂时失败：'));
const replaceableReadHandoffSql="(handoff_reason IS NULL OR handoff_reason='' OR handoff_reason IN ('本机助手未连接，请启动本机助手并连接抖音后重新同步','本机助手暂未核实当前账号，请在助手中完成账号核验后重新同步','会话读取尚不可靠，已暂停自动回复','会话读取尚不可靠，已暂停自动回复；请稍后重新同步，核实消息后再继续。','会话读取失败，已转交销售','会话面板未打开或需要人工操作，未发送。','会话已恢复同步，可继续人工回复') OR handoff_reason LIKE '会话同步暂时失败：%')";
// Mirror the journal's completed-retry ancestry proof without rewriting send history.
// Full input equality after removing retry preserves the approved message and identity.
const resolvedSendAncestorSql=(job:string)=>`(${job}.kind='send' AND ${job}.status='unknown' AND EXISTS (
 WITH RECURSIVE lineage(root_id,id,next_id,depth,path,base_input) AS (
  SELECT completed.id,completed.id,json_extract(completed.input_json,'$.retry.previousJobId'),0,json_array(completed.id),json_remove(completed.input_json,'$.retry')
  FROM workbench_prospect_jobs completed WHERE completed.kind='send' AND completed.status='done'
   AND completed.owner_id=${job}.owner_id AND completed.member_id=${job}.member_id AND completed.sender_id=${job}.sender_id AND completed.campaign_id=${job}.campaign_id
   AND json_extract(completed.input_json,'$.senderAccountId')=${job}.sender_id
   AND json_extract(completed.input_json,'$.recipientId')=json_extract(${job}.input_json,'$.recipientId')
   AND json_type(completed.input_json,'$.message')='text' AND length(json_extract(completed.input_json,'$.message'))>0
   AND json_type(completed.input_json,'$.retry')='object' AND json_type(completed.input_json,'$.retry.previousJobId')='text'
  UNION ALL
  SELECT lineage.root_id,parent.id,json_extract(parent.input_json,'$.retry.previousJobId'),lineage.depth+1,json_insert(lineage.path,'$[#]',parent.id),lineage.base_input
  FROM lineage JOIN workbench_prospect_jobs parent ON parent.id=lineage.next_id
  WHERE lineage.depth<100 AND typeof(lineage.next_id)='text' AND parent.kind='send'
   AND parent.owner_id=${job}.owner_id AND parent.member_id=${job}.member_id AND parent.sender_id=${job}.sender_id AND parent.campaign_id=${job}.campaign_id
   AND json_remove(parent.input_json,'$.retry')=lineage.base_input
   AND NOT EXISTS (SELECT 1 FROM json_each(lineage.path) seen WHERE seen.value=parent.id)
 ), valid_roots AS (SELECT root_id FROM lineage WHERE next_id IS NULL OR next_id='')
 SELECT 1 FROM lineage ancestor JOIN valid_roots valid ON valid.root_id=ancestor.root_id WHERE ancestor.depth>0 AND ancestor.id=${job}.id
))`;
const unresolvedOutboundSql=(job:string)=>`(${job}.kind IN ('send','reply') AND ${job}.status IN ('unknown','running') AND NOT ${resolvedSendAncestorSql(job)})`;
const recoverableReadPauseSql=`status='active' AND EXISTS (SELECT 1 FROM workbench_prospect_devices verified WHERE verified.owner_id=workbench_prospect_conversations.owner_id AND verified.member_id=workbench_prospect_conversations.member_id AND verified.enabled=1 AND verified.authenticated=1 AND verified.account_id=workbench_prospect_conversations.sender_id) AND handoff_reason IS NOT NULL AND (${replaceableReadHandoffSql} OR (mode='agent' AND handoff_reason='${RESUME_PENDING}')) AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs uncertain WHERE uncertain.owner_id=workbench_prospect_conversations.owner_id AND uncertain.sender_id=workbench_prospect_conversations.sender_id AND ${unresolvedOutboundSql('uncertain')} AND json_extract(uncertain.input_json,'$.recipientId')=workbench_prospect_conversations.recipient_id)`;
const messageSelect='SELECT m.*,m.rowid AS row_order,j.status AS job_status,j.error AS job_error,j.result_json AS job_result_json FROM workbench_prospect_messages m LEFT JOIN workbench_prospect_jobs j ON j.id=m.job_id';
const sendText=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw new DomainError('回复内容需为1至1000个字符');return value;};
const MANUAL_SYNC_INTERVAL_MS=8000;
// Kept out of the eligible=1 processing queue until a reliable read confirms it.
const UNVERIFIED_STOP=-1;
const UNVERIFIED_AUTO_INBOUND=-2;
export const isProspectChatJob=(kind:string)=>kind==='readConversation'||kind==='reply';

export const prospectReplyCountsSql=(job:string)=>`NOT (${job}.status='failed' AND COALESCE(json_extract(${job}.result_json,'$.outcome'),'')='failed' AND COALESCE(json_extract(${job}.result_json,'$.retryable'),0)=1 AND COALESCE(json_extract(${job}.result_json,'$.errorCode'),'')='ACCOUNT_VERIFICATION_PENDING')`;

/** These predicates run inside the atomic lease write, so two campaigns share one quota. */
export function prospectReplyPolicyGate(job:string,campaign:string,nowMs:number,renew=false){
 const dayStart=new Date(Math.floor((nowMs+8*3600000)/86400000)*86400000-8*3600000).toISOString();
 const clock=new Date(nowMs+8*3600000).toISOString().slice(11,16);
 const started=renew?` AND counted.id!=${job}.id`:'';
 const rawStart=`json_extract(${campaign}.data_json,'$.chatPolicy.workStart')`,rawEnd=`json_extract(${campaign}.data_json,'$.chatPolicy.workEnd')`;
 const validHours=`COALESCE((${rawStart} GLOB '[0-2][0-9]:[0-5][0-9]' AND ${rawStart}<'24:00' AND ${rawEnd} GLOB '[0-2][0-9]:[0-5][0-9]' AND ${rawEnd}<'24:00' AND ${rawStart}<${rawEnd}),0)`;
 const hoursEnabled=`CASE WHEN json_type(${campaign}.data_json,'$.chatPolicy.replyHoursEnabled') IN ('true','false') THEN json_extract(${campaign}.data_json,'$.chatPolicy.replyHoursEnabled') ELSE (${validHours} AND (${rawStart}!='08:30' OR ${rawEnd}!='21:30')) END`;
 const workStart=`CASE WHEN ${validHours} THEN ${rawStart} ELSE '08:30' END`,workEnd=`CASE WHEN ${validHours} THEN ${rawEnd} ELSE '21:30' END`;
 return {sql:`(${job}.kind!='reply' OR json_extract(${job}.input_json,'$.actor')='human' OR (
  COALESCE(json_extract(${job}.input_json,'$.policyVersion'),0)=COALESCE(json_extract(${campaign}.data_json,'$.chatPolicyVersion'),0)
  AND (${hoursEnabled}=0 OR (?>=${workStart} AND ?<${workEnd}))
  AND (SELECT COUNT(*) FROM workbench_prospect_jobs counted WHERE counted.owner_id=${job}.owner_id AND counted.sender_id=${job}.sender_id AND counted.kind='reply' AND ${prospectReplyCountsSql('counted')} AND counted.started_at>=?${started})<COALESCE(json_extract(${campaign}.data_json,'$.chatPolicy.replyDailyLimit'),30)
  AND (SELECT COUNT(*) FROM workbench_prospect_jobs counted WHERE counted.owner_id=${job}.owner_id AND counted.sender_id=${job}.sender_id AND counted.kind='reply' AND ${prospectReplyCountsSql('counted')} AND json_extract(counted.input_json,'$.conversationId')=json_extract(${job}.input_json,'$.conversationId') AND counted.started_at>?${started})<COALESCE(json_extract(${campaign}.data_json,'$.chatPolicy.conversationReplyLimit'),12)))`,values:[clock,clock,dayStart,new Date(nowMs-86400000).toISOString()]};
}
export const prospectContactAllowedSql=(job:string)=>`NOT EXISTS (SELECT 1 FROM workbench_prospect_contact_optouts stopped WHERE stopped.owner_id=${job}.owner_id AND stopped.sender_id=${job}.sender_id AND stopped.recipient_id=json_extract(${job}.input_json,'$.recipientId'))`;

export function createProspectingChatStore(db:D1Database,now:()=>number=Date.now){
 const memoryStore=createProspectMemoryStore(db,now);
 const stamp=()=>new Date(now()).toISOString();
 async function member(ownerId:string,memberId:string){const row=await db.prepare("SELECT role,sales_id FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1 AND role IN ('sales','manager')").bind(ownerId,memberId).first<{role:MemberRole;sales_id:string|null}>();if(!row)throw new DomainError('业务账号已停用或无权操作',403);return row;}
 async function campaign(ownerId:string,memberId:string,id:string){await member(ownerId,memberId);const row=await db.prepare('SELECT * FROM workbench_prospect_campaigns WHERE id=? AND owner_id=? AND member_id=?').bind(id,ownerId,memberId).first<CampaignRow>();if(!row)throw new DomainError('获客任务不存在',404);return row;}
 async function ownConversation(ownerId:string,memberId:string,id:string){await member(ownerId,memberId);const row=await db.prepare('SELECT * FROM workbench_prospect_conversations WHERE id=? AND owner_id=? AND member_id=?').bind(id,ownerId,memberId).first<ConversationRow>();if(!row)throw new DomainError('会话不存在或无权操作',404);return row;}
 async function device(ownerId:string,memberId:string){return db.prepare('SELECT * FROM workbench_prospect_devices WHERE owner_id=? AND member_id=? AND enabled=1 ORDER BY created_at DESC,id DESC LIMIT 1').bind(ownerId,memberId).first<DeviceRow>();}
 async function ready(c:ConversationRow){const d=await device(c.owner_id,c.member_id);if(!d||!d.last_seen_at||now()-Date.parse(d.last_seen_at)>=90000)throw new DomainError('本机助手未连接，请启动本机助手并连接抖音后重新同步',503);if(d.account_id&&d.account_id!==c.sender_id)throw new DomainError('当前登录账号与会话发送账号不一致，请在助手中切回原账号后重新同步',409);if(!d.authenticated||!d.account_id||d.account_id.startsWith('dy-readonly-'))throw new DomainError('本机助手暂未核实当前账号，请在助手中完成账号核验后重新同步',503);return d;}
 const conversationReads="owner_id=? AND member_id=? AND campaign_id=? AND lead_id=? AND sender_id=? AND kind='readConversation' AND json_extract(input_json,'$.conversationId')=?";
 const conversationReadKeys=(c:ConversationRow)=>[c.owner_id,c.member_id,c.campaign_id,c.lead_id,c.sender_id,c.id];
 async function materialize(ownerId:string,memberId:string){
  await member(ownerId,memberId);
  const rows=await db.prepare("SELECT j.*,l.data_json AS lead_json FROM workbench_prospect_jobs j JOIN workbench_prospect_leads l ON l.campaign_id=j.campaign_id AND l.id=j.lead_id WHERE j.owner_id=? AND j.member_id=? AND j.kind='send' AND j.status='done' AND NOT EXISTS (SELECT 1 FROM workbench_prospect_conversations c WHERE c.owner_id=j.owner_id AND c.sender_id=j.sender_id AND c.recipient_id=json_extract(j.input_json,'$.recipientId')) ORDER BY j.created_at,j.id LIMIT 50").bind(ownerId,memberId).all<ProspectJobRow&{lead_json:string}>();
  for(const row of rows.results){const input=object(JSON.parse(row.input_json)),lead=object(JSON.parse(row.lead_json));if(typeof input.recipientId!=='string'||typeof input.profileUrl!=='string'||!row.sender_id)continue;const id=`pcv-${(await prospectHash(`${ownerId}\0${row.sender_id}\0${input.recipientId}`)).slice(0,32)}`,opened=row.started_at??row.created_at;
   await db.prepare("INSERT INTO workbench_prospect_conversations(id,owner_id,member_id,campaign_id,lead_id,sender_id,recipient_id,profile_url,nickname,opened_at,last_message_at,last_message_preview,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,sender_id,recipient_id) DO NOTHING").bind(id,ownerId,memberId,row.campaign_id,row.lead_id,row.sender_id,input.recipientId,input.profileUrl,text(lead.nickname,100)||'抖音用户',opened,row.updated_at,text(input.message,200),stamp()).run();
   if(typeof input.message==='string')await db.prepare("INSERT INTO workbench_prospect_messages(id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,posted_at,created_at,job_id,processed) VALUES (?,?,?,?,?,'outbound',?,?,'sent',?,?,?,1) ON CONFLICT(conversation_id,source_key) DO NOTHING").bind(`pcm-${(await prospectHash(`greeting:${row.id}`)).slice(0,32)}`,id,ownerId,memberId,`greeting:${row.id}`,lead.reviewedBy==='自动策略'?'agent':'human',input.message,row.updated_at,row.updated_at,row.id).run();
  }
  const unmapped=await db.prepare('SELECT c.id FROM workbench_prospect_conversations c WHERE c.owner_id=? AND c.member_id=? AND NOT EXISTS (SELECT 1 FROM workbench_prospect_memory_bindings b WHERE b.thread_id=c.id) LIMIT 20').bind(ownerId,memberId).all<{id:string}>();
  for(const c of unmapped.results)await memoryStore.getView(ownerId,memberId,c.id);
  await db.prepare("UPDATE workbench_prospect_conversations SET mode='human',memory_json=json_set(memory_json,'$.stage','handoff'),handoff_reason='上一条回复结果待确认，正在等待可靠的外发消息记录',version=version+1,updated_at=? WHERE owner_id=? AND member_id=? AND mode='agent' AND EXISTS (SELECT 1 FROM workbench_prospect_jobs j WHERE j.kind='reply' AND j.status='unknown' AND json_extract(j.input_json,'$.conversationId')=workbench_prospect_conversations.id)").bind(stamp(),ownerId,memberId).run();
 }
 async function snapshot(ownerId:string,memberId:string,_role:MemberRole,campaignId?:string,conversationId?:string):Promise<ProspectChatSnapshot>{
  const account=await member(ownerId,memberId);const task=campaignId?await campaign(ownerId,memberId,campaignId):null;
  await materialize(ownerId,memberId);const d=await device(ownerId,memberId);
  type ScopedRow=ConversationRow&{scoped_memory_json:string|null;scoped_session_id:string|null;scoped_campaign_id:string|null};
  const conversations=await db.prepare(`SELECT c.*,${lastSyncedSql},s.state_json AS scoped_memory_json,s.id AS scoped_session_id,s.campaign_id AS scoped_campaign_id FROM workbench_prospect_conversations c LEFT JOIN workbench_prospect_memory_sessions s ON s.thread_id=c.id AND s.owner_id=c.owner_id AND s.member_id=c.member_id AND s.campaign_id=COALESCE(?,c.campaign_id) WHERE c.owner_id=? AND c.member_id=?${campaignId?' AND s.campaign_id=?':''} ORDER BY c.last_message_at DESC,c.id LIMIT 100`).bind(campaignId??null,ownerId,memberId,...(campaignId?[campaignId]:[])).all<ScopedRow>();
  let selected=conversationId?conversations.results.find(c=>c.id===conversationId):conversations.results[0];
  if(conversationId&&!selected){
   if(campaignId)throw new DomainError('当前任务中不存在该会话',404);
   selected=await db.prepare(`SELECT c.* FROM workbench_prospect_conversations c WHERE c.id=? AND c.owner_id=? AND EXISTS (SELECT 1 FROM workbench_prospect_lead_pool p WHERE p.conversation_id=c.id AND p.owner_id=c.owner_id${account.role==='manager'?'':' AND p.assigned_member_id=?'})`).bind(conversationId,ownerId,...(account.role==='manager'?[]:[memberId])).first<ScopedRow>()??undefined;
   if(!selected)throw new DomainError('会话不存在或无权访问',404);conversations.results.push(selected);
  }
  const taskView=selected?await memoryStore.getView(ownerId,selected.member_id,selected.id,campaignId):undefined;
  const messages=selected&&taskView?(await db.prepare(`${messageSelect} LEFT JOIN workbench_prospect_memory_sources ms ON ms.message_id=m.id WHERE ms.session_id=? OR (?=1 AND m.conversation_id=? AND ms.message_id IS NULL) ORDER BY m.created_at DESC,m.rowid DESC LIMIT 100`).bind(taskView.sessionId,taskView.bindingVersion===1?1:0,selected.id).all<MessageRow>()).results.reverse().map(publicMessage):[];
  const pool=(await db.prepare(`SELECT p.* FROM workbench_prospect_lead_pool p WHERE p.owner_id=?${account.role==='manager'?'':' AND p.assigned_member_id=?'}${campaignId?' AND EXISTS (SELECT 1 FROM workbench_prospect_memory_captures mc JOIN workbench_prospect_memory_sessions s ON s.id=mc.session_id WHERE mc.capture_id=p.id AND s.campaign_id=? AND s.owner_id=p.owner_id AND s.member_id=?)':''} ORDER BY p.score DESC,p.updated_at DESC,p.id LIMIT 200`).bind(ownerId,...(account.role==='manager'?[]:[memberId]),...(campaignId?[campaignId,memberId]:[])).all<PoolRow>()).results.map(publicPool);
  const latestRead=selected?.member_id===memberId?await db.prepare(`SELECT status,updated_at,error FROM workbench_prospect_jobs WHERE ${conversationReads} ORDER BY updated_at DESC,rowid DESC LIMIT 1`).bind(...conversationReadKeys(selected)).first<Pick<ProspectJobRow,'status'|'updated_at'|'error'>>():null;
  const sync=latestRead&&selected?{conversationId:selected.id,status:latestRead.status,updatedAt:latestRead.updated_at,...(latestRead.error?{error:latestRead.error}:{})}:undefined;
  const publicConversations=conversations.results.map(c=>{
   const v=c.id===selected?.id?taskView:undefined;const state=v?.state??(c.scoped_memory_json?JSON.parse(c.scoped_memory_json) as TaskMemoryState:undefined);
   const scopedCampaign=v?.campaignId??c.scoped_campaign_id??c.campaign_id;
   return{...publicConversation({...c,campaign_id:scopedCampaign,contact_captured:state?.contact.captured?1:0}),...(state?{memory:{...projectTaskMemory(state,stamp()),...(c.status==='closed'?{stage:'closed' as const}:c.mode==='human'?{stage:'handoff' as const}:{})}}:{}),...(v?{taskMemory:v,memoryEditable:c.member_id===memberId}:{})};
  });
  const memoryTasks=selected?.member_id===memberId?(await db.prepare('SELECT id,data_json FROM workbench_prospect_campaigns WHERE owner_id=? AND member_id=? ORDER BY created_at DESC,id LIMIT 50').bind(ownerId,memberId).all<{id:string;data_json:string}>()).results.map(r=>({id:r.id,name:text(object(JSON.parse(r.data_json)).name,80)||'获客任务'})):[];
  const libraries=(await db.prepare("SELECT id,name FROM workbench_knowledge_libraries WHERE owner_id=? AND (department_id='shared' OR department_id=?) ORDER BY created_at,id").bind(ownerId,knowledgeDepartmentForSalesId(account.sales_id)).all<{id:string;name:string}>()).results;
  const visiblePolicy=normalizeChatPolicy(task?object(JSON.parse(task.data_json)).chatPolicy:undefined);visiblePolicy.libraryIds=visiblePolicy.libraryIds.filter(id=>libraries.some(l=>l.id===id));
  return{policy:visiblePolicy,libraries:libraries.map(l=>({id:l.id,name:l.name})),enabled:!!task&&object(JSON.parse(task.data_json)).chatEnabled===true,online:!!d?.last_seen_at&&now()-Date.parse(d.last_seen_at)<90000&&!!d.authenticated,conversations:publicConversations,messages,pool,memoryTasks,...(sync?{sync}:{})};
 }
 function cancelQueued(conversationId:string,guard:string,values:unknown[],actor?:'agent'|'human'){
  return[
   db.prepare(`UPDATE workbench_prospect_jobs SET status='cancelled',active_key=NULL,error='会话控制或新消息已改变，原回复已取消',updated_at=? WHERE kind='reply' AND status='queued' AND json_extract(input_json,'$.conversationId')=?${actor?" AND json_extract(input_json,'$.actor')=?":''} AND EXISTS (${guard})`).bind(stamp(),conversationId,...(actor?[actor]:[]),...values),
   db.prepare(`UPDATE workbench_prospect_messages SET status='cancelled' WHERE conversation_id=? AND job_id IN (SELECT id FROM workbench_prospect_jobs WHERE status='cancelled') AND EXISTS (${guard})`).bind(conversationId,...values),
  ];
 }
 function waitingCancellation(ownerId:string,memberId:string,campaignId?:string,guard?:string,values:unknown[]=[]){
  return db.prepare(`UPDATE workbench_prospect_messages SET status='cancelled',error='会话或任务已改变，原待发回复已取消' WHERE owner_id=? AND member_id=? AND status='waiting'${campaignId?' AND conversation_id IN (SELECT id FROM workbench_prospect_conversations WHERE campaign_id=?)':''}${guard?` AND conversation_id=(SELECT id FROM workbench_prospect_conversations WHERE processing_token=?) AND EXISTS (${guard})`:''}`).bind(ownerId,memberId,...(campaignId?[campaignId]:[]),...(guard?[values.at(-1)]:[]),...values);
 }
 async function settings(ownerId:string,memberId:string,campaignId:string,enabled:boolean,policyValue?:unknown){
  const previous=await campaign(ownerId,memberId,campaignId);if(typeof enabled!=='boolean')throw new DomainError('会话开关参数无效');const time=stamp();
  if(policyValue!==undefined){const supplied=object(policyValue);if(supplied.replyHoursEnabled!==undefined&&typeof supplied.replyHoursEnabled!=='boolean'||!policyValue||typeof policyValue!=='object'||Array.isArray(policyValue)||!Array.isArray(supplied.libraryIds)||supplied.libraryIds.length>20||supplied.libraryIds.some(id=>typeof id!=='string'||!id.trim()||id.length>160)||!Number.isInteger(supplied.replyDailyLimit)||Number(supplied.replyDailyLimit)<1||Number(supplied.replyDailyLimit)>80||!Number.isInteger(supplied.conversationReplyLimit)||Number(supplied.conversationReplyLimit)<1||Number(supplied.conversationReplyLimit)>30||typeof supplied.workStart!=='string'||typeof supplied.workEnd!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(supplied.workStart)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(supplied.workEnd)||supplied.workStart>=supplied.workEnd)throw new DomainError('会话策略参数无效，请检查回复上限和工作时间');}
  const suppliedPolicy=policyValue===undefined?undefined:normalizeChatPolicy(policyValue);
  const policy=suppliedPolicy&&JSON.stringify(suppliedPolicy)!==JSON.stringify(normalizeChatPolicy(object(JSON.parse(previous.data_json)).chatPolicy))?suppliedPolicy:undefined;
  if(policy?.libraryIds.length){const account=await member(ownerId,memberId);const allowed=await db.prepare(`SELECT COUNT(*) AS total FROM workbench_knowledge_libraries WHERE owner_id=? AND (department_id='shared' OR department_id=?) AND id IN (${policy.libraryIds.map(()=>'?').join(',')})`).bind(ownerId,knowledgeDepartmentForSalesId(account.sales_id),...policy.libraryIds).first<{total:number}>();if(allowed?.total!==policy.libraryIds.length)throw new DomainError('只能选择所属部门或共享知识库',403);}
  const statements=[db.prepare(`UPDATE workbench_prospect_campaigns SET data_json=json_set(data_json,'$.chatEnabled',json(?)${policy?",'$.chatPolicy',json(?),'$.chatPolicyVersion',COALESCE(json_extract(data_json,'$.chatPolicyVersion'),0)+1":''}),updated_at=? WHERE id=? AND owner_id=? AND member_id=?`).bind(JSON.stringify(enabled),...(policy?[JSON.stringify(policy)]:[]),time,campaignId,ownerId,memberId)];
  if(policy){statements.push(
   db.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='会话策略已更新，原回复已停止，请销售人工继续跟进',memory_json=json_set(memory_json,'$.stage','handoff') WHERE owner_id=? AND member_id=? AND campaign_id=? AND status='active' AND EXISTS (SELECT 1 FROM workbench_prospect_jobs j WHERE j.kind='reply' AND j.status IN ('queued','running') AND json_extract(j.input_json,'$.actor')='agent' AND json_extract(j.input_json,'$.conversationId')=workbench_prospect_conversations.id)").bind(ownerId,memberId,campaignId),
   db.prepare("UPDATE workbench_prospect_jobs SET status='cancelled',active_key=NULL,error='会话策略已更新，原自动回复已取消',updated_at=? WHERE owner_id=? AND member_id=? AND campaign_id=? AND kind='reply' AND status='queued' AND json_extract(input_json,'$.actor')='agent'").bind(time,ownerId,memberId,campaignId),
   db.prepare("UPDATE workbench_prospect_messages SET status='cancelled' WHERE owner_id=? AND member_id=? AND job_id IN (SELECT id FROM workbench_prospect_jobs WHERE campaign_id=? AND status='cancelled')").bind(ownerId,memberId,campaignId),
   db.prepare("UPDATE workbench_prospect_conversations SET processing_token=NULL,processing_until=NULL,version=version+1,updated_at=? WHERE campaign_id=? AND owner_id=? AND member_id=? AND status='active'").bind(time,campaignId,ownerId,memberId));}
  if(!enabled){statements.push(db.prepare("UPDATE workbench_prospect_jobs SET status='cancelled',active_key=NULL,error='会话同步已关闭',updated_at=? WHERE owner_id=? AND member_id=? AND campaign_id=? AND kind IN ('readConversation','reply') AND status='queued'").bind(time,ownerId,memberId,campaignId),db.prepare("UPDATE workbench_prospect_messages SET status='cancelled' WHERE owner_id=? AND member_id=? AND job_id IN (SELECT id FROM workbench_prospect_jobs WHERE status='cancelled')").bind(ownerId,memberId),db.prepare('UPDATE workbench_prospect_conversations SET processing_token=NULL,processing_until=NULL,version=version+1,updated_at=? WHERE campaign_id=? AND owner_id=? AND member_id=?').bind(time,campaignId,ownerId,memberId));}
  if(policy||!enabled)statements.push(waitingCancellation(ownerId,memberId,campaignId));
  await db.batch(statements);await materialize(ownerId,memberId);
 }
 async function control(ownerId:string,memberId:string,id:string,version:number,mode:'agent'|'human'){
  const c=await ownConversation(ownerId,memberId,id);if(c.version!==version||c.status!=='active')throw conflict();const token=crypto.randomUUID(),time=stamp(),guard='SELECT 1 FROM workbench_prospect_conversations WHERE id=? AND processing_token=?';
  if(mode==='agent'){
   const task=await campaign(ownerId,memberId,c.campaign_id);if(task.status!=='active'||object(JSON.parse(task.data_json)).chatEnabled!==true)throw new DomainError('请先启用会话并恢复获客任务，再恢复自动回复',409);
   if(await db.prepare(`SELECT uncertain.id FROM workbench_prospect_jobs uncertain WHERE uncertain.owner_id=? AND uncertain.sender_id=? AND ${unresolvedOutboundSql('uncertain')} AND json_extract(uncertain.input_json,'$.recipientId')=? LIMIT 1`).bind(ownerId,c.sender_id,c.recipient_id).first())throw new DomainError('上一条回复仍在执行或结果待确认，可靠同步核实之前不能恢复自动回复',409);
   if(await db.prepare('SELECT 1 FROM workbench_prospect_contact_optouts WHERE owner_id=? AND sender_id=? AND recipient_id=?').bind(ownerId,c.sender_id,c.recipient_id).first())throw new DomainError('客户已要求停止联系，不能恢复自动回复',409);
  }
  const results=await db.batch([
   db.prepare(`UPDATE workbench_prospect_conversations SET mode=?,handoff_reason=?,last_snapshot_id=CASE WHEN ?=1 THEN NULL ELSE last_snapshot_id END,version=version+1,processing_token=?,processing_until=NULL,updated_at=? WHERE id=? AND owner_id=? AND member_id=? AND version=? AND status='active'${mode==='agent'?` AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs uncertain WHERE uncertain.owner_id=workbench_prospect_conversations.owner_id AND uncertain.sender_id=workbench_prospect_conversations.sender_id AND json_extract(uncertain.input_json,'$.recipientId')=workbench_prospect_conversations.recipient_id AND ${unresolvedOutboundSql('uncertain')})`:''}`).bind(mode,mode==='human'?'已由销售接管':RESUME_PENDING,mode==='agent'?1:0,token,time,id,ownerId,memberId,version),
   ...cancelQueued(id,guard,[id,token]),waitingCancellation(ownerId,memberId,undefined,guard,[id,token]),
   db.prepare('UPDATE workbench_prospect_conversations SET processing_token=NULL WHERE id=? AND processing_token=?').bind(id,token),
  ]);if(!results[0].meta.changes)throw conflict();
 }
 const takeover=(ownerId:string,memberId:string,id:string,version:number)=>control(ownerId,memberId,id,version,'human');
 const resume=(ownerId:string,memberId:string,id:string,version:number)=>control(ownerId,memberId,id,version,'agent');
 function replyStatements(c:ConversationRow,d:DeviceRow,message:string,actor:'agent'|'human',guard:string,values:unknown[],metadata:unknown={},policyVersion?:number,view?:TaskMemoryView){
  const jobId=`pj-${crypto.randomUUID()}`,replyId=`pcm-${crypto.randomUUID()}`,time=stamp();
  const answered=object(metadata).answeredMessageIds;const input={...(Array.isArray(answered)?{answeredMessageIds:answered.filter((id):id is string=>typeof id==='string').slice(0,100)}:{}),senderAccountId:c.sender_id,recipientId:c.recipient_id,profileUrl:c.profile_url,message,replyId,expectedSnapshotId:c.last_snapshot_id,conversationId:c.id,actor,...(view?{sessionId:view.sessionId,bindingVersion:view.bindingVersion}:{}),...(actor==='agent'?{policyVersion:policyVersion??0,knowledgeLookup:object(metadata).knowledgeLookup}:{})};
  return{jobId,statements:[
   db.prepare(`INSERT INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,result_json,active_key,sender_id,created_at,updated_at) SELECT ?,?,?,?,?,?,'reply','queued',?,?,?,?,?,? WHERE EXISTS (${guard}) AND NOT EXISTS (SELECT 1 FROM workbench_prospect_contact_optouts WHERE owner_id=? AND sender_id=? AND recipient_id=?) AND EXISTS (SELECT 1 FROM workbench_prospect_devices WHERE id=? AND enabled=1 AND authenticated=1 AND account_id=?) AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs uncertain WHERE uncertain.owner_id=? AND uncertain.sender_id=? AND json_extract(uncertain.input_json,'$.recipientId')=? AND ${unresolvedOutboundSql('uncertain')})`).bind(jobId,c.owner_id,c.member_id,d.id,c.campaign_id,c.lead_id,JSON.stringify(input),JSON.stringify(metadata),`chat-reply:${c.id}`,c.sender_id,time,time,...values,c.owner_id,c.sender_id,c.recipient_id,d.id,c.sender_id,c.owner_id,c.sender_id,c.recipient_id),
   db.prepare("INSERT INTO workbench_prospect_messages(id,conversation_id,owner_id,member_id,source_key,direction,actor,text,status,created_at,job_id,processed) SELECT ?,?,?,?,?,'outbound',?,?,'queued',?,?,1 WHERE EXISTS (SELECT 1 FROM workbench_prospect_jobs WHERE id=?)").bind(replyId,c.id,c.owner_id,c.member_id,`reply:${replyId}`,actor,message,time,jobId,jobId),
   ...(view?[memoryStore.attributeMessage(replyId,view,`EXISTS (${guard})`,values,{freshAfterBaselineGuard:'1'})]:[]),
  ]};
 }
 async function reply(ownerId:string,memberId:string,id:string,version:number,message:string){
  sendText(message);const c=await ownConversation(ownerId,memberId,id);if(c.version!==version||c.status!=='active')throw conflict();const task=await campaign(ownerId,memberId,c.campaign_id);
  if(task.status!=='active'||object(JSON.parse(task.data_json)).chatEnabled!==true||!c.last_snapshot_id)throw new DomainError('请先启用并完成一次会话同步',409);
  if(await db.prepare("SELECT id FROM workbench_prospect_jobs WHERE kind='reply' AND status IN ('running','unknown') AND json_extract(input_json,'$.conversationId')=? LIMIT 1").bind(id).first())throw new DomainError('上一条回复仍在执行或结果待确认，请等待会话同步后再回复',409);
  const d=await ready(c),token=crypto.randomUUID(),guard='SELECT 1 FROM workbench_prospect_conversations WHERE id=? AND processing_token=?';
  const view=await memoryStore.getView(ownerId,memberId,id);const queued=replyStatements(c,d,message,'human',guard,[id,token],{},undefined,view);
  const results=await db.batch([
   db.prepare("UPDATE workbench_prospect_conversations SET mode='human',handoff_reason='已由销售接管',version=version+1,processing_token=?,processing_until=NULL,updated_at=? WHERE id=? AND owner_id=? AND member_id=? AND version=? AND status='active'").bind(token,stamp(),id,ownerId,memberId,version),
   ...cancelQueued(id,guard,[id,token]),waitingCancellation(ownerId,memberId,undefined,guard,[id,token]),...queued.statements,
   db.prepare('UPDATE workbench_prospect_conversations SET processing_token=NULL WHERE id=? AND processing_token=?').bind(id,token),
  ]);if(!results[0].meta.changes)throw conflict();
 }
 async function queueRead(c:ConversationRow,d:DeviceRow,manual?:{observeOnly:boolean}){
  const view=await memoryStore.getView(c.owner_id,c.member_id,c.id);const time=stamp(),input={sessionId:view.sessionId,bindingVersion:view.bindingVersion,senderAccountId:c.sender_id,recipientId:c.recipient_id,profileUrl:c.profile_url,conversationId:c.id,limit:80,...(manual?{manualSync:true,observeOnly:manual.observeOnly}:{})};
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
 async function hasQueuedConversationWork(deviceId:string){return Boolean(await db.prepare("SELECT 1 FROM workbench_prospect_jobs WHERE device_id=? AND status='queued' AND kind IN ('readConversation','reply') LIMIT 1").bind(deviceId).first());}
 async function schedule(deviceId:string){
  const d=await db.prepare("SELECT d.* FROM workbench_prospect_devices d JOIN workbench_member_accounts m ON m.account_id=d.member_id AND m.owner_id=d.owner_id WHERE d.id=? AND d.enabled=1 AND d.authenticated=1 AND m.enabled=1 AND m.role IN ('sales','manager')").bind(deviceId).first<DeviceRow>();if(!d?.account_id||d.account_id.startsWith('dy-readonly-'))return;
  await materialize(d.owner_id,d.member_id);
  // Completed attempts govern pacing even when no reliable observation exists.
  // Rotating by attempt time lets unread or failing conversations share the device.
  const c=await db.prepare(`SELECT c.* FROM workbench_prospect_conversations c JOIN workbench_prospect_campaigns p ON p.id=c.campaign_id
   LEFT JOIN workbench_prospect_jobs attempted ON attempted.id=(SELECT j.id FROM workbench_prospect_jobs j WHERE j.owner_id=c.owner_id AND j.member_id=c.member_id AND j.sender_id=c.sender_id AND j.kind='readConversation' AND json_extract(j.input_json,'$.conversationId')=c.id ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1)
   WHERE c.owner_id=? AND c.member_id=? AND c.sender_id=? AND c.status='active' AND p.status='active' AND json_extract(p.data_json,'$.chatEnabled')=1
    AND (attempted.id IS NULL OR attempted.updated_at<=CASE WHEN attempted.status='done' AND COALESCE(json_extract(attempted.result_json,'$.reliable'),json_extract(attempted.result_json,'$.summary') LIKE '已同步%')=1 THEN ? ELSE ? END)
    AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs j WHERE j.active_key=('chat-read:'||c.id))
   ORDER BY COALESCE(attempted.updated_at,''),c.id LIMIT 1`).bind(d.owner_id,d.member_id,d.account_id,new Date(now()-30000).toISOString(),new Date(now()-15000).toISOString()).first<ConversationRow>();if(!c)return;
  await queueRead(c,d);
 }
 function closeStatements(c:ConversationRow,reason:string,memory:ReturnType<typeof normalizeChatMemory>,guard:string,values:unknown[]){
  const time=stamp();memory.stage='closed';
  return[
   db.prepare(`UPDATE workbench_prospect_messages SET status='cancelled',error='客户已要求停止联系，原待发回复已取消' WHERE conversation_id=? AND status='waiting' AND EXISTS (${guard})`).bind(c.id,...values),
   db.prepare(`INSERT INTO workbench_prospect_contact_optouts(owner_id,sender_id,recipient_id,reason,created_at) SELECT ?,?,?,?,? WHERE EXISTS (${guard}) ON CONFLICT(owner_id,sender_id,recipient_id) DO NOTHING`).bind(c.owner_id,c.sender_id,c.recipient_id,reason,time,...values),
   db.prepare(`UPDATE workbench_prospect_jobs SET status='cancelled',active_key=NULL,error='客户已要求停止联系，排队发送已取消',updated_at=? WHERE owner_id=? AND sender_id=? AND kind IN ('send','reply') AND status='queued' AND json_extract(input_json,'$.recipientId')=? AND EXISTS (${guard})`).bind(time,c.owner_id,c.sender_id,c.recipient_id,...values),
   db.prepare(`UPDATE workbench_prospect_messages SET status='cancelled' WHERE owner_id=? AND job_id IN (SELECT id FROM workbench_prospect_jobs WHERE status='cancelled') AND EXISTS (${guard})`).bind(c.owner_id,...values),
  ];
 }
 async function assertJob(row:ProspectJobRow){
  const input=object(JSON.parse(row.input_json));const c=await ownConversation(row.owner_id,row.member_id,String(input.conversationId));const p=await campaign(row.owner_id,row.member_id,c.campaign_id);
  const view=await memoryStore.getView(row.owner_id,row.member_id,c.id);if(row.campaign_id!==c.campaign_id||input.sessionId!==undefined&&(input.sessionId!==view.sessionId||input.bindingVersion!==view.bindingVersion)||input.sessionId===undefined&&view.bindingVersion!==1)throw new DomainError('接待任务已改变，请停止原会话任务',409);
  if(await db.prepare('SELECT 1 FROM workbench_prospect_contact_optouts WHERE owner_id=? AND sender_id=? AND recipient_id=?').bind(c.owner_id,c.sender_id,c.recipient_id).first())throw new DomainError('客户已要求停止联系，请停止执行',409);
  const manualRead=row.kind==='readConversation'&&input.manualSync===true;
  if(c.status!=='active'||p.status!=='active'||(!manualRead&&object(JSON.parse(p.data_json)).chatEnabled!==true)||c.sender_id!==row.sender_id||input.senderAccountId!==c.sender_id||input.recipientId!==c.recipient_id||input.profileUrl!==c.profile_url)throw new DomainError('会话状态或身份已改变，请停止执行',409);
  if(row.kind==='reply'&&input.actor!=='human'&&(Number(input.policyVersion)||0)!==(Number(object(JSON.parse(p.data_json)).chatPolicyVersion)||0))throw new DomainError('会话策略已更新，请停止原自动回复',409);
  if(row.kind==='reply'&&input.actor!=='human'&&!await eligibleReply(c,p,row.id))throw new DomainError('自动回复已超过工作时间或回复额度上限，请停止执行',409);
  if(row.kind==='reply'&&(input.actor!==c.mode&&!(input.actor==='human'&&c.mode==='human')||input.expectedSnapshotId!==c.last_snapshot_id))throw new DomainError('会话已被接管或收到新消息，请停止原回复',409);
  return c;
 }
 function normalizeRead(row:ProspectJobRow,value:unknown):ProspectChatReadResult{
  const v=object(value),input=object(JSON.parse(row.input_json));
  if(v.senderAccountId!==row.sender_id||v.recipientId!==input.recipientId)throw new DomainError('会话读取身份与绑定账号不一致',409);
  if(typeof v.observedAt!=='string'||!Number.isFinite(Date.parse(v.observedAt))||Math.abs(Date.parse(v.observedAt)-now())>300000||typeof v.snapshotId!=='string'||!v.snapshotId||v.snapshotId.length>256||typeof v.reliable!=='boolean'||v.covered!==undefined&&typeof v.covered!=='boolean'||!Array.isArray(v.messages)||v.messages.length>100)throw new DomainError('会话读取结果格式不正确');
  const ids=new Set<string>();const messages=v.messages.map(raw=>{const m=object(raw);if(typeof m.id!=='string'||!m.id||m.id.length>256||ids.has(m.id)||!['inbound','outbound'].includes(String(m.direction))||typeof m.text!=='string'||!m.text.trim()||m.text.length>4000)throw new DomainError('会话消息格式不正确');if(m.contentType!==undefined&&!['text','image'].includes(String(m.contentType))||m.contentType==='image'&&m.text!=='[图片消息，内容未识别]')throw new DomainError('非文本消息类型或占位信息不正确');ids.add(m.id);if(m.postedAt!==undefined&&(typeof m.postedAt!=='string'||!Number.isFinite(Date.parse(m.postedAt))||Date.parse(m.postedAt)>Date.parse(v.observedAt as string)+300000))throw new DomainError('会话消息时间无效');return{id:m.id,direction:m.direction as 'inbound'|'outbound',text:m.text,...(m.contentType==='image'?{contentType:'image' as const}:{}),...(typeof m.postedAt==='string'?{postedAt:new Date(m.postedAt).toISOString()}:{})};});
  return{senderAccountId:String(v.senderAccountId),recipientId:String(v.recipientId),observedAt:new Date(v.observedAt).toISOString(),snapshotId:v.snapshotId,reliable:v.reliable,...(typeof v.covered==='boolean'?{covered:v.covered}:{}),messages};
 }
 async function complete(row:ProspectJobRow,result:unknown,error?:string){
  const input=object(JSON.parse(row.input_json)),c=await ownConversation(row.owner_id,row.member_id,String(input.conversationId));const guard="SELECT 1 FROM workbench_prospect_jobs WHERE id=? AND status='running' AND lease_hash=?",values=[row.id,row.lease_hash],time=stamp();
  if(row.kind==='reply'){
   const value=object(result);if(!error&&!['submitted','failed','unknown'].includes(String(value.outcome)))throw new DomainError('会话回复结果格式不正确');const status=error?'unknown':value.outcome==='submitted'?'done':String(value.outcome),problem=safeProspectError(error||value.error);
   const metadata=row.result_json?object(JSON.parse(row.result_json)):{};
   const retryable=status==='failed'&&!error&&retryableResult(value);
   const durableWait=retryable&&input.actor==='agent';
   const waitCurrent="SELECT 1 FROM workbench_prospect_conversations current JOIN workbench_prospect_campaigns policy ON policy.id=current.campaign_id AND policy.owner_id=current.owner_id AND policy.member_id=current.member_id WHERE current.id=? AND current.version=? AND current.mode='agent' AND current.status='active' AND policy.status='active' AND json_extract(policy.data_json,'$.chatEnabled')=1 AND COALESCE(json_extract(policy.data_json,'$.chatPolicyVersion'),0)=?";
   const waitValues=[c.id,c.version,Number(input.policyVersion)||0];
   const retryAttempt=Number.isInteger(metadata.retryAttempt)?Number(metadata.retryAttempt):0;
   const retryAt=new Date(now()+(retryAttempt===0?60000:300000)).toISOString();
   const technicalProblem=retryable?`会话同步暂时失败：${problem||'暂未核实当前账号'}；请稍后重新同步，核实消息后再继续。`:problem||'回复未能确认，已转交销售';
   await db.batch([
    ...(status==='done'&&input.actor==='human'?[db.prepare(`UPDATE workbench_prospect_messages SET processed=1 WHERE conversation_id=? AND direction='inbound' AND rowid<(SELECT rowid FROM workbench_prospect_messages WHERE job_id=? LIMIT 1) AND EXISTS (${guard})`).bind(c.id,row.id,...values)]:[]),
    db.prepare(`UPDATE workbench_prospect_messages SET status=CASE WHEN ?='waiting' AND NOT EXISTS (${waitCurrent}) THEN 'cancelled' ELSE ? END,error=? WHERE job_id=? AND EXISTS (${guard})`).bind(durableWait?'waiting':status==='done'?'sent':status,...waitValues,durableWait?'waiting':status==='done'?'sent':status,problem||null,row.id,...values),
    db.prepare(`UPDATE workbench_prospect_conversations SET memory_json=CASE WHEN ?='done' OR ?=1 OR status='closed' THEN memory_json ELSE json_set(memory_json,'$.stage','handoff') END,mode=CASE WHEN ?='done' OR ?=1 THEN mode ELSE 'human' END,last_snapshot_id=CASE WHEN ?=1 THEN NULL ELSE last_snapshot_id END,processing_token=NULL,processing_until=NULL,handoff_reason=CASE WHEN ?='done' THEN handoff_reason WHEN ?=1 AND NOT ${replaceableReadHandoffSql} THEN handoff_reason ELSE ? END,last_message_at=CASE WHEN ?='done' THEN ? ELSE last_message_at END,last_message_preview=CASE WHEN ?='done' THEN ? ELSE last_message_preview END,version=version+1,updated_at=? WHERE id=? AND EXISTS (${guard}) AND (?=0 OR EXISTS (${waitCurrent}))`).bind(status,retryable?1:0,status,retryable?1:0,retryable?1:0,status,retryable?1:0,technicalProblem,status,time,status,text(input.message,200),time,c.id,...values,retryable?1:0,...waitValues),
    db.prepare("UPDATE workbench_prospect_jobs SET status=?,result_json=?,error=?,active_key=NULL,updated_at=? WHERE id=? AND status='running' AND lease_hash=?").bind(status,JSON.stringify({...metadata,...(retryable?{retryable:true,errorCode:'ACCOUNT_VERIFICATION_PENDING',replyWait:durableWait,retryAttempt,retryAt,retryExhausted:retryAttempt>=2,manualAuthorized:false}:{}),outcome:status==='done'?'submitted':status,summary:status==='done'?'会话回复已提交，未验证送达':status==='unknown'?'会话回复结果待确认':'会话回复未提交',evidence:text(value.evidence,500)}),problem||null,time,...values),
   ]);return;
  }
  const task=await campaign(row.owner_id,row.member_id,c.campaign_id);
  const automatic=task.status==='active'&&object(JSON.parse(task.data_json)).chatEnabled===true&&input.observeOnly!==true;
  if(error){await db.batch([
   ...(automatic?[...cancelQueued(c.id,guard,values),db.prepare(`UPDATE workbench_prospect_conversations SET last_snapshot_id=NULL,handoff_reason=CASE WHEN ${replaceableReadHandoffSql} THEN ? ELSE handoff_reason END,version=version+1,processing_token=NULL,processing_until=NULL,updated_at=? WHERE id=? AND EXISTS (${guard})`).bind(`会话同步暂时失败：${safeProspectError(error)||'暂未取得可核实消息'}；请稍后重新同步，核实消息后再继续。`,time,c.id,...values)]:[]),
   db.prepare("UPDATE workbench_prospect_jobs SET status='failed',error=?,active_key=NULL,updated_at=? WHERE id=? AND status='running' AND lease_hash=?").bind(safeProspectError(error),time,...values),
  ]);return;}
  const read=normalizeRead(row,result);if(c.last_read_at&&read.observedAt<c.last_read_at)throw new DomainError('会话读取结果已过期',409);
  const taskView=await memoryStore.getView(c.owner_id,c.member_id,c.id);const binding=(await db.prepare('SELECT updated_at,switched_watermark FROM workbench_prospect_memory_bindings WHERE thread_id=?').bind(c.id).first<{updated_at:string;switched_watermark:number}>())!;
  const platformExisting=(await db.prepare('SELECT m.*,m.rowid AS row_order,j.status AS job_status,j.started_at AS job_started_at,j.result_json AS job_result_json FROM workbench_prospect_messages m LEFT JOIN workbench_prospect_jobs j ON j.id=m.job_id WHERE m.conversation_id=? ORDER BY m.created_at,m.rowid').bind(c.id).all<MessageRow>()).results;const bySource=new Map(platformExisting.map(m=>[m.source_key,m]));
  const sessionIds=new Set((await db.prepare('SELECT message_id FROM workbench_prospect_memory_sources WHERE session_id=?').bind(taskView.sessionId).all<{message_id:string}>()).results.map(r=>r.message_id));const existing=platformExisting.filter(m=>sessionIds.has(m.id));
  const statements:D1PreparedStatement[]=[],sourceStatements:D1PreparedStatement[]=[];
  const unresolved=!!await db.prepare(`SELECT 1 FROM workbench_prospect_jobs uncertain WHERE uncertain.owner_id=? AND uncertain.sender_id=? AND ${unresolvedOutboundSql('uncertain')} AND json_extract(uncertain.input_json,'$.recipientId')=? LIMIT 1`).bind(c.owner_id,c.sender_id,c.recipient_id).first();
  const resuming=c.mode==='agent'&&c.handoff_reason===RESUME_PENDING;
  const recovering=c.status==='active'&&automatic&&read.reliable&&isTechnicalReadPause(c.handoff_reason)&&!unresolved;
  const greeting=existing.find(m=>m.source_key.startsWith('greeting:'));
  const anchors=greeting?read.messages.flatMap((m,index)=>m.direction==='outbound'&&m.text===greeting.text?[index]:[]):[];
  const anchor=anchors.length===1?anchors[0]:-1;
  // Resume insertion and resume authorization must use the same proof. A plain
  // baseline cannot promote untimed history into tomorrow's "known" anchor.
  const resumeFreshness=new Map<string,boolean>();
  if(resuming){
   const currentAfter=Date.parse(taskView.bindingVersion===1?c.opened_at:binding.updated_at);
   const knownCurrentSources=new Set(existing.filter(message=>message.direction==='inbound'&&message.eligible===1||message.direction==='outbound'&&!!message.job_id&&(message.status==='sent'||message.job_status==='done')&&Date.parse(message.created_at)>=currentAfter).map(message=>message.source_key));
   let knownBefore=false;
   for(const [index,m] of read.messages.entries()){
    const previous=bySource.get(m.id),postedAt=m.postedAt??previous?.posted_at;
    const currentSource=!previous||sessionIds.has(previous.id);
    const newlyObserved=(!previous||previous.processed===0&&[1,UNVERIFIED_AUTO_INBOUND].includes(previous.eligible))&&knownBefore;
    resumeFreshness.set(m.id,currentSource&&(postedAt?Date.parse(postedAt)>=currentAfter:anchor>=0&&index>anchor||newlyObserved));
    if(knownCurrentSources.has(m.id))knownBefore=true;
   }
  }
  let precedingOutbound=existing.filter(m=>m.direction==='outbound'&&(m.status==='sent'||m.job_status==='done')).at(-1)?.text??'',stopObserved=false;
  for(const [index,m] of read.messages.entries()){if(m.direction==='outbound')precedingOutbound=m.text;const previous=bySource.get(m.id);
   if(previous&&(previous.direction!==m.direction||previous.text!==m.text||(previous.content_type??'text')!==(m.contentType??'text')))throw new DomainError('已记录消息的身份或正文发生变化，请重新同步',409);
   const stopped=isChatOptOut(m.text,precedingOutbound),postedAt=m.postedAt??previous?.posted_at;
   const physicalFresh=postedAt?Date.parse(postedAt)>=Date.parse(c.opened_at):anchor>=0&&index>anchor||Boolean(previous?previous.eligible===1||previous.eligible===UNVERIFIED_STOP||previous.eligible===UNVERIFIED_AUTO_INBOUND:c.has_baseline);
   const knownAnchor=Math.max(-1,...read.messages.flatMap((item,i)=>bySource.has(item.id)?[i]:[]));
   const fresh=resuming?resumeFreshness.get(m.id)===true:taskView.bindingVersion===1?physicalFresh:postedAt?Date.parse(postedAt)>=Date.parse(binding.updated_at):Boolean(c.has_baseline&&knownAnchor>=0&&index>knownAnchor);
   const eligible=(automatic||stopped)&&read.reliable&&m.direction==='inbound'&&fresh;
   // A previously unreliable observation must not permanently hide a later
   // verified stop. Other existing messages keep their original replay gates.
   if(read.reliable&&m.direction==='inbound'&&physicalFresh&&stopped)stopObserved=true;
   if(read.reliable){const messageId=previous?.id??`pcm-${(await prospectHash(`${c.id}\0${m.id}`)).slice(0,32)}`;sourceStatements.push(memoryStore.attributeMessage(messageId,taskView,`EXISTS (${guard})`,values,{freshAfterBaselineGuard:'?=1',values:[c.has_baseline&&fresh?1:0]}));}
   if(previous){
    if(eligible&&previous.eligible===UNVERIFIED_AUTO_INBOUND)statements.push(db.prepare(`UPDATE workbench_prospect_messages SET eligible=1 WHERE id=? AND eligible=? AND processed=0 AND EXISTS (${guard})`).bind(previous.id,UNVERIFIED_AUTO_INBOUND,...values));
    continue;
   }
   const localMatches=m.direction==='outbound'?existing.filter(local=>local.direction==='outbound'&&local.text===m.text&&(local.source_key.startsWith('reply:')||local.source_key.startsWith('greeting:'))&&((local.status==='sent'||local.job_status==='done')&&(!m.postedAt||Math.abs(Date.parse(m.postedAt)-Date.parse(local.job_started_at??local.posted_at??local.created_at))<300000)||local.job_status==='unknown'&&m.postedAt&&local.job_started_at&&Date.parse(m.postedAt)>=Date.parse(local.job_started_at))):[];
   if(localMatches.length===1&&read.messages.filter(other=>other.direction==='outbound'&&other.text===m.text).length===1){const local=localMatches[0];statements.push(db.prepare(`UPDATE workbench_prospect_messages SET source_key=?,posted_at=COALESCE(?,posted_at),status='sent' WHERE id=? AND EXISTS (${guard})`).bind(m.id,m.postedAt??null,local.id,...values));continue;}
   const id=`pcm-${(await prospectHash(`${c.id}\0${m.id}`)).slice(0,32)}`;
   const eligibility=eligible?1:!read.reliable&&m.direction==='inbound'&&fresh?(stopped?UNVERIFIED_STOP:automatic?UNVERIFIED_AUTO_INBOUND:0):0;
   statements.push(db.prepare(`INSERT INTO workbench_prospect_messages(id,conversation_id,owner_id,member_id,source_key,direction,actor,text,content_type,status,posted_at,created_at,eligible) SELECT ?,?,?,?,?,?,?,?,?,'received',?,?,? WHERE EXISTS (${guard}) ON CONFLICT(conversation_id,source_key) DO NOTHING`).bind(id,c.id,c.owner_id,c.member_id,m.id,m.direction,m.direction==='inbound'?'customer':'human',m.text,m.contentType??'text',m.postedAt??null,read.observedAt,eligibility,...values));
  }
  statements.push(...sourceStatements);
  const changed=read.snapshotId!==c.last_snapshot_id;const last=read.messages.at(-1);
  if(changed||!read.reliable)statements.push(...cancelQueued(c.id,guard,values));
  // Matching outgoing evidence resolves an ambiguous reply without another send.
  if(read.reliable)for(const m of read.messages.filter(m=>m.direction==='outbound'&&!bySource.has(m.id)&&m.postedAt)){
   statements.push(db.prepare(`UPDATE workbench_prospect_jobs SET status='done',result_json=json_set(COALESCE(result_json,'{}'),'$.outcome','submitted','$.summary','后续会话同步已观察到相同外发消息'),error=NULL,active_key=NULL,updated_at=? WHERE kind='reply' AND status='unknown' AND json_extract(input_json,'$.conversationId')=? AND json_extract(input_json,'$.message')=? AND started_at<=? AND EXISTS (${guard})`).bind(time,c.id,m.text,m.postedAt!,...values));
  }
  const waiting=existing.filter(m=>m.status==='waiting'&&m.job_id&&m.job_status==='failed'&&retryableResult(m.job_result_json?JSON.parse(m.job_result_json):{}));
  if(recovering&&!resuming&&!waiting.length){
   const latest=existing.filter(m=>m.direction==='inbound'&&m.eligible===1).at(-1);
   const durableDraft=!!latest&&existing.some(m=>{if(m.direction!=='outbound'||(m.row_order??0)<=(latest.row_order??0))return false;const meta=m.job_result_json?object(JSON.parse(m.job_result_json)):{};return meta.replyWait===true||typeof meta.waitingFromJobId==='string';});
   const confirmedOut=existing.filter(m=>m.direction==='outbound'&&(m.status==='sent'||m.job_status==='done'||!m.job_id&&m.status==='received'&&c.last_read_at&&m.created_at<=c.last_read_at)).at(-1);
   const index=latest?read.messages.findIndex(m=>m.id===latest.source_key):-1;
   const newerOutgoingInRead=index>=0&&read.messages.slice(index+1).some(m=>m.direction==='outbound');
   const unanswered=index>=0&&latest&&latest.processed===1&&(!confirmedOut||(latest.row_order??0)>(confirmedOut.row_order??0))&&!newerOutgoingInRead;
   if(unanswered&&!durableDraft)statements.push(db.prepare(`UPDATE workbench_prospect_messages SET processed=0 WHERE id=? AND EXISTS (${guard}) AND EXISTS (SELECT 1 FROM workbench_prospect_conversations WHERE id=? AND version=? AND ${recoverableReadPauseSql})`).bind(latest.id,...values,c.id,c.version));
  }
  // Legacy decisions had no audit marker: reconsider only the current last inbound once.
  const audit=object(JSON.parse(c.memory_json||'{}'));
  const legacyLast=last?.direction==='inbound'?bySource.get(last.id):undefined;
  if(automatic&&read.reliable&&c.status==='active'&&c.mode==='agent'&&!c.handoff_reason&&!unresolved&&!stopObserved&&c.has_baseline&&legacyLast?.eligible===1&&sessionIds.has(legacyLast.id)&&!isQuietProspectAcknowledgement(legacyLast.text,existing.filter(m=>m.direction==='outbound'&&(m.row_order??0)<(legacyLast.row_order??0)).at(-1)?.text)&&legacyLast.processed===1&&!audit.lastDecision&&audit.legacyRecoveredInboundId!==legacyLast.id&&
    !platformExisting.some(m=>m.direction==='outbound'&&(m.row_order??0)>(legacyLast.row_order??0))){
   const legacyGuard=`EXISTS (${guard}) AND EXISTS (SELECT 1 FROM workbench_prospect_conversations live JOIN workbench_prospect_campaigns task ON task.id=live.campaign_id WHERE live.id=? AND live.version=? AND live.mode='agent' AND live.status='active' AND live.handoff_reason IS NULL AND task.status='active' AND json_extract(task.data_json,'$.chatEnabled')=1 AND EXISTS (SELECT 1 FROM workbench_prospect_devices d WHERE d.owner_id=live.owner_id AND d.member_id=live.member_id AND d.enabled=1 AND d.authenticated=1 AND d.account_id=live.sender_id))`;
   const legacyValues=[...values,c.id,c.version];
   statements.push(db.prepare(`UPDATE workbench_prospect_messages SET processed=0 WHERE id=? AND ${legacyGuard}`).bind(legacyLast.id,...legacyValues));
   statements.push(db.prepare(`UPDATE workbench_prospect_conversations SET memory_json=json_set(memory_json,'$.legacyRecoveredInboundId',?) WHERE id=? AND ${legacyGuard}`).bind(legacyLast.id,c.id,...legacyValues));
  }
  let resumeVerified=false;
  const resumeGuard=`EXISTS (${guard}) AND EXISTS (SELECT 1 FROM workbench_prospect_conversations WHERE id=? AND version=? AND mode='agent' AND handoff_reason=? AND ${recoverableReadPauseSql})`;
  if(recovering&&resuming&&last?.direction==='outbound'){
   const answeredIds=read.messages.filter(m=>m.direction==='inbound').map(m=>m.id);
   statements.push(db.prepare(`UPDATE workbench_prospect_messages SET processed=1 WHERE conversation_id=? AND direction='inbound' AND eligible=1 AND source_key IN (SELECT value FROM json_each(?)) AND ${resumeGuard}`).bind(c.id,JSON.stringify(answeredIds),...values,c.id,c.version,RESUME_PENDING));
  }
  if(recovering&&resuming&&last?.direction==='inbound'){
   const previous=bySource.get(last.id),postedAt=last.postedAt??previous?.posted_at;
   const fresh=resumeFreshness.get(last.id)===true;
   const confirmedOut=existing.filter(m=>m.direction==='outbound'&&(m.status==='sent'||m.job_status==='done'||!m.job_id&&m.status==='received'&&c.last_read_at&&m.created_at<=c.last_read_at)).at(-1);
   const answered=!!confirmedOut&&(previous?(confirmedOut.row_order??0)>(previous.row_order??0):!!postedAt&&!!confirmedOut.posted_at&&Date.parse(confirmedOut.posted_at)>Date.parse(postedAt));
   if(answered)statements.push(db.prepare(`UPDATE workbench_prospect_messages SET processed=1 WHERE conversation_id=? AND direction='inbound' AND eligible=1 AND source_key IN (SELECT value FROM json_each(?)) AND ${resumeGuard}`).bind(c.id,JSON.stringify(read.messages.filter(m=>m.direction==='inbound').map(m=>m.id)),...values,c.id,c.version,RESUME_PENDING));
   if(fresh&&!answered){
    resumeVerified=true;
    statements.push(db.prepare(`UPDATE workbench_prospect_messages SET processed=1 WHERE conversation_id=? AND direction='inbound' AND eligible=1 AND source_key!=? AND ${resumeGuard}`).bind(c.id,last.id,...values,c.id,c.version,RESUME_PENDING));
    statements.push(db.prepare(`UPDATE workbench_prospect_messages SET eligible=1,processed=0 WHERE conversation_id=? AND source_key=? AND direction='inbound' AND ${resumeGuard}`).bind(c.id,last.id,...values,c.id,c.version,RESUME_PENDING));
   }
  }
  statements.push(db.prepare(`UPDATE workbench_prospect_conversations SET last_read_at=CASE WHEN ?=1 THEN ? ELSE last_read_at END,last_snapshot_id=?,has_baseline=CASE WHEN ?=1 THEN 1 ELSE has_baseline END,last_message_at=?,last_message_preview=?,mode=CASE WHEN ?=1 AND ${recoverableReadPauseSql} THEN 'agent' ELSE mode END,handoff_reason=CASE WHEN ?=1 AND ${replaceableReadHandoffSql} THEN '会话读取尚不可靠，已暂停自动回复；请稍后重新同步，核实消息后再继续。' WHEN ?=1 AND ${recoverableReadPauseSql} THEN NULL ELSE handoff_reason END,version=version+?,processing_token=CASE WHEN ?=1 THEN NULL ELSE processing_token END,processing_until=CASE WHEN ?=1 THEN NULL ELSE processing_until END,updated_at=? WHERE id=? AND EXISTS (${guard})`).bind(read.reliable?1:0,read.observedAt,read.reliable||read.covered===true?read.snapshotId:null,read.reliable?1:0,last?.postedAt??(last?read.observedAt:c.last_message_at),last?text(last.text,200):c.last_message_preview,recovering&&(!resuming||resumeVerified)?1:0,automatic&&!read.reliable?1:0,recovering&&(!resuming||resumeVerified)?1:0,changed||!read.reliable?1:0,changed||!read.reliable?1:0,changed||!read.reliable?1:0,time,c.id,...values));
  if(stopObserved){const memory=normalizeChatMemory(c.memory_json),reason='客户明确要求停止联系';
   statements.push(...closeStatements(c,reason,memory,guard,values));
   statements.push(db.prepare(`UPDATE workbench_prospect_conversations SET status='closed',close_reason=?,memory_json=?,processing_token=NULL,processing_until=NULL,version=version+1,updated_at=? WHERE id=? AND EXISTS (${guard})`).bind(reason,JSON.stringify(memory),time,c.id,...values));
  }
  if(read.reliable)for(const draft of waiting){
   const previous=await db.prepare("SELECT * FROM workbench_prospect_jobs WHERE id=? AND kind='reply' AND status='failed'").bind(draft.job_id).first<ProspectJobRow>();if(!previous)continue;
   const planned=object(JSON.parse(previous.input_json)),metadata=previous.result_json?object(JSON.parse(previous.result_json)):{};
   const actor=planned.actor,policyVersion=Number(object(JSON.parse(task.data_json)).chatPolicyVersion)||0;
   const novelTurn=read.messages.some(m=>!bySource.has(m.id));
   const invalid=stopObserved||!automatic||c.mode!==actor||read.snapshotId!==planned.expectedSnapshotId||novelTurn||actor==='agent'&&(Number(planned.policyVersion)||0)!==policyVersion;
   if(invalid){statements.push(db.prepare(`UPDATE workbench_prospect_messages SET status='cancelled',error='会话或任务已改变，原待发回复已取消' WHERE id=? AND job_id=? AND status='waiting' AND EXISTS (${guard})`).bind(draft.id,previous.id,...values));continue;}
   const retryAttempt=Number(metadata.retryAttempt)||0,manual=retryAttempt>=2&&input.manualSync===true,authorized=metadata.manualAuthorized===true||manual;
   if(manual)statements.push(db.prepare(`UPDATE workbench_prospect_jobs SET result_json=json_set(result_json,'$.manualAuthorized',json('true')) WHERE id=? AND status='failed' AND EXISTS (${guard}) AND EXISTS (SELECT 1 FROM workbench_prospect_messages WHERE id=? AND job_id=? AND status='waiting')`).bind(previous.id,...values,draft.id,previous.id));
   if(!Number.isFinite(Date.parse(String(metadata.retryAt)))||Date.parse(String(metadata.retryAt))>now()||retryAttempt>=2&&!authorized)continue;
   const nextId=`pj-${crypto.randomUUID()}`,nextMetadata={evidenceIds:metadata.evidenceIds,decisionReason:metadata.decisionReason,retryAttempt:retryAttempt+1,waitingFromJobId:previous.id,rootReplyJobId:metadata.rootReplyJobId??previous.id};
   statements.push(db.prepare(`INSERT OR IGNORE INTO workbench_prospect_jobs(id,owner_id,member_id,device_id,campaign_id,lead_id,kind,status,input_json,result_json,active_key,sender_id,created_at,updated_at)
    SELECT ?,prior.owner_id,prior.member_id,prior.device_id,prior.campaign_id,prior.lead_id,'reply','queued',prior.input_json,?, ?,prior.sender_id,?,? FROM workbench_prospect_jobs prior
    JOIN workbench_prospect_messages draft ON draft.job_id=prior.id JOIN workbench_prospect_conversations thread ON thread.id=draft.conversation_id
    JOIN workbench_prospect_campaigns policy ON policy.id=prior.campaign_id JOIN workbench_prospect_devices device ON device.id=prior.device_id
    WHERE prior.id=? AND prior.status='failed' AND prior.input_json=? AND json_extract(prior.result_json,'$.replyWait')=1 AND json_extract(prior.result_json,'$.retryable')=1 AND json_extract(prior.result_json,'$.errorCode')='ACCOUNT_VERIFICATION_PENDING'
     AND json_extract(prior.result_json,'$.retryAt')<=? AND (COALESCE(json_extract(prior.result_json,'$.retryAttempt'),0)<2 OR json_extract(prior.result_json,'$.manualAuthorized')=1)
     AND draft.id=? AND draft.status='waiting' AND draft.id=json_extract(prior.input_json,'$.replyId') AND draft.text=json_extract(prior.input_json,'$.message') AND draft.actor=json_extract(prior.input_json,'$.actor')
     AND thread.owner_id=prior.owner_id AND thread.member_id=prior.member_id AND thread.campaign_id=prior.campaign_id AND thread.sender_id=prior.sender_id AND thread.recipient_id=json_extract(prior.input_json,'$.recipientId')
     AND thread.profile_url=json_extract(prior.input_json,'$.profileUrl') AND thread.status='active' AND thread.version=? AND thread.mode=draft.actor AND thread.last_snapshot_id=json_extract(prior.input_json,'$.expectedSnapshotId')
     AND policy.owner_id=prior.owner_id AND policy.member_id=prior.member_id AND policy.status='active' AND json_extract(policy.data_json,'$.chatEnabled')=1 AND (draft.actor='human' OR COALESCE(json_extract(prior.input_json,'$.policyVersion'),0)=COALESCE(json_extract(policy.data_json,'$.chatPolicyVersion'),0))
     AND device.owner_id=prior.owner_id AND device.member_id=prior.member_id AND device.enabled=1 AND device.authenticated=1 AND device.account_id=prior.sender_id AND device.last_seen_at>?
     AND NOT EXISTS (SELECT 1 FROM workbench_prospect_contact_optouts stopped WHERE stopped.owner_id=prior.owner_id AND stopped.sender_id=prior.sender_id AND stopped.recipient_id=thread.recipient_id)
     AND NOT EXISTS (SELECT 1 FROM workbench_prospect_jobs uncertain WHERE uncertain.owner_id=prior.owner_id AND uncertain.sender_id=prior.sender_id AND json_extract(uncertain.input_json,'$.recipientId')=thread.recipient_id AND ${unresolvedOutboundSql('uncertain')}) AND EXISTS (${guard})`).bind(nextId,JSON.stringify(nextMetadata),`chat-reply:${c.id}`,time,time,previous.id,previous.input_json,time,draft.id,c.version+(changed?1:0),new Date(now()-90000).toISOString(),...values));
   statements.push(db.prepare("UPDATE workbench_prospect_messages SET job_id=?,status='queued',error=NULL WHERE id=? AND job_id=? AND status='waiting' AND EXISTS (SELECT 1 FROM workbench_prospect_jobs WHERE id=? AND status='queued')").bind(nextId,draft.id,previous.id,nextId));
  }
  statements.push(db.prepare("UPDATE workbench_prospect_jobs SET status='done',result_json=?,error=?,active_key=NULL,updated_at=? WHERE id=? AND status='running' AND lease_hash=?").bind(JSON.stringify({summary:read.reliable?`已同步${read.messages.length}条可核实消息`:'读取结果未通过可靠性检查，未启动自动回复',reliable:read.reliable,observedAt:read.observedAt}),read.reliable?null:'读取结果尚不可靠；请稍后重新同步，核实消息后再继续。',time,...values));
  await db.batch(statements);
 }
 async function captureStatement(c:ConversationRow,pending:MessageRow[],decision:ProspectChatDecision,guard:string,values:unknown[]){
  const lead=decision.lead;if(!lead||!['phone','wechat','email'].includes(lead.contactType)||typeof lead.contactValue!=='string'||!lead.contactValue||lead.contactValue.length>120||!pending.some(inbound=>inbound.text.includes(lead.contactValue))||!Number.isFinite(lead.score)||lead.score<0||lead.score>100||!['high','medium','low'].includes(lead.grade))return null;
  const canonical=lead.contactType==='email'?lead.contactValue.toLowerCase():lead.contactType==='phone'?lead.contactValue.replace(/\D/g,''):lead.contactValue;
  if(lead.contactType==='phone'&&!/^\d{7,15}$/.test(canonical)||lead.contactType==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.contactValue))return null;
  const contactKey=await prospectHash(`${lead.contactType}\0${canonical}`),time=stamp();
  const assignee="SELECT m.account_id FROM workbench_member_accounts m WHERE m.owner_id=? AND m.enabled=1 AND m.role='sales' ORDER BY CASE WHEN EXISTS (SELECT 1 FROM workbench_prospect_lead_pool same WHERE same.owner_id=m.owner_id AND same.conversation_id=? AND same.assigned_member_id=m.account_id) THEN 0 ELSE 1 END,(SELECT COUNT(DISTINCT p.conversation_id) FROM workbench_prospect_lead_pool p WHERE p.owner_id=m.owner_id AND p.assigned_member_id=m.account_id AND p.status='assigned'),m.account_id LIMIT 1";
  return{contactKey,statement:db.prepare(`INSERT INTO workbench_prospect_lead_pool(id,owner_id,conversation_id,contact_key,contact_type,contact_value,nickname,score,grade,reason,assigned_member_id,assigned_name,status,created_at,updated_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,s.account_id,s.display_name,CASE WHEN s.account_id IS NULL THEN 'unassigned' ELSE 'assigned' END,?,? FROM (SELECT 1) LEFT JOIN workbench_member_accounts s ON s.account_id=(${assignee}) AND s.owner_id=? WHERE EXISTS (${guard})
   ON CONFLICT(owner_id,conversation_id,contact_key) DO UPDATE SET score=excluded.score,grade=excluded.grade,reason=excluded.reason,assigned_member_id=excluded.assigned_member_id,assigned_name=excluded.assigned_name,status=excluded.status,updated_at=excluded.updated_at`).bind(`pcl-${crypto.randomUUID()}`,c.owner_id,c.id,contactKey,lead.contactType,lead.contactValue,c.nickname,Math.round(lead.score),lead.grade,text(lead.reason,500),time,time,c.owner_id,c.id,c.owner_id,...values)};
 }
 async function eligibleReply(c:ConversationRow,task:CampaignRow,excludeId=''){
  const policy=normalizeChatPolicy(object(JSON.parse(task.data_json)).chatPolicy);
  if(!withinChatHours(now(),policy))return false;
  const dayStart=new Date(Math.floor((now()+8*3600000)/86400000)*86400000-8*3600000).toISOString();
  const row=await db.prepare(`SELECT SUM(CASE WHEN started_at>=? THEN 1 ELSE 0 END) AS day_count,SUM(CASE WHEN started_at>? AND json_extract(input_json,'$.conversationId')=? THEN 1 ELSE 0 END) AS conversation_count FROM workbench_prospect_jobs WHERE owner_id=? AND sender_id=? AND kind='reply' AND ${prospectReplyCountsSql('workbench_prospect_jobs')} AND id!=? AND started_at>?`).bind(dayStart,new Date(now()-86400000).toISOString(),c.id,c.owner_id,c.sender_id,excludeId,new Date(Math.min(Date.parse(dayStart),now()-86400000)).toISOString()).first<{day_count:number;conversation_count:number}>();
  return (row?.day_count||0)<policy.replyDailyLimit&&(row?.conversation_count||0)<policy.conversationReplyLimit;
 }
 type Remember=(ownerId:string,origin:string,state:TaskMemoryState,messages:TaskMemoryMessage[],options:TaskMemoryOptions)=>Promise<TaskMemoryState>;
 async function rememberOne(ownerId:string,memberId:string,origin:string,remember?:Remember):Promise<boolean>{
  await member(ownerId,memberId);await materialize(ownerId,memberId);
  const due=await db.prepare(`SELECT c.id FROM workbench_prospect_conversations c LEFT JOIN workbench_prospect_memory_bindings b ON b.thread_id=c.id LEFT JOIN workbench_prospect_memory_sessions s ON s.id=b.active_session_id WHERE c.owner_id=? AND c.member_id=? AND (b.thread_id IS NULL OR COALESCE(json_array_length(json_extract(s.state_json,'$.pendingSourceIds')),0)>0 OR EXISTS (SELECT 1 FROM workbench_prospect_memory_sources x JOIN workbench_prospect_messages m ON m.id=x.message_id LEFT JOIN workbench_prospect_jobs j ON j.id=m.job_id WHERE x.session_id=s.id AND (x.row_order>s.source_watermark OR x.processed_status IS NULL OR m.direction='outbound' AND x.processed_status!=COALESCE(j.status,m.status))) OR EXISTS (SELECT 1 FROM workbench_prospect_messages m WHERE m.conversation_id=c.id AND m.rowid<=b.legacy_watermark AND m.eligible>=0 AND (m.created_at<=b.legacy_verified_at OR EXISTS (SELECT 1 FROM workbench_prospect_jobs j WHERE j.id=m.job_id AND j.status='done')) AND NOT EXISTS (SELECT 1 FROM workbench_prospect_memory_sources x WHERE x.message_id=m.id))) ORDER BY COALESCE(s.updated_at,''),c.last_message_at,c.id LIMIT 20`).bind(ownerId,memberId).all<{id:string}>();
  for(const c of due.results)if(await memoryStore.absorb(ownerId,memberId,c.id,remember?(s,m,o)=>remember(ownerId,origin,s,m,o):undefined))return true;
  return false;
 }
 const memoryView=(ownerId:string,memberId:string,id:string,campaignId?:string)=>memoryStore.getView(ownerId,memberId,id,campaignId);
 const memoryEdit=(ownerId:string,memberId:string,id:string,campaignId:string,sessionVersion:number,bindingVersion:number,change:TaskMemoryEdit)=>memoryStore.mutate(ownerId,memberId,id,campaignId,sessionVersion,bindingVersion,change);
 const switchTask=(ownerId:string,memberId:string,id:string,targetCampaignId:string,threadVersion:number,bindingVersion:number)=>memoryStore.switchTask(ownerId,memberId,id,targetCampaignId,threadVersion,bindingVersion);
 async function assertActiveCampaign(ownerId:string,memberId:string,id:string,campaignId?:string){if(campaignId&&!(await memoryStore.getView(ownerId,memberId,id,campaignId)).isActive)throw new DomainError('该任务当前未接待此客户，请先切换接待任务',409);}
 async function processOne(ownerId:string,memberId:string,origin:string,decide?: (ownerId:string,origin:string,input:ProspectChatAgentInput)=>Promise<ProspectChatDecision>,stopOnly=false):Promise<boolean>{
  await member(ownerId,memberId);await materialize(ownerId,memberId);const token=crypto.randomUUID(),time=stamp();
  const dayStart=new Date(Math.floor((now()+8*3600000)/86400000)*86400000-8*3600000).toISOString();
  // One D1 query loads the bounded candidate window and its gates. Even outside
  // working hours this never fans out into a request per dormant conversation.
  const candidates=(await db.prepare(`SELECT c.*,${capturedContactSql},p.status AS campaign_status,p.data_json AS campaign_json,
   (SELECT m.text FROM workbench_prospect_messages m WHERE m.conversation_id=c.id AND m.direction='outbound' ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_outbound,
   (SELECT json_group_array(text) FROM (SELECT m.text FROM workbench_prospect_messages m WHERE m.conversation_id=c.id AND m.direction='inbound' AND m.eligible=1 AND m.processed=0 ORDER BY m.created_at,m.rowid LIMIT 100)) AS pending_json,
   (EXISTS (SELECT 1 FROM workbench_prospect_messages waiting WHERE waiting.conversation_id=c.id AND waiting.status='waiting') OR EXISTS (SELECT 1 FROM workbench_prospect_jobs j WHERE j.kind='reply' AND j.status IN ('queued','running') AND json_extract(j.input_json,'$.conversationId')=c.id) OR EXISTS (SELECT 1 FROM workbench_prospect_jobs uncertain WHERE uncertain.owner_id=c.owner_id AND uncertain.sender_id=c.sender_id AND json_extract(uncertain.input_json,'$.recipientId')=c.recipient_id AND ${unresolvedOutboundSql('uncertain')})) AS has_reply,
   (SELECT COUNT(*) FROM workbench_prospect_jobs counted WHERE counted.owner_id=c.owner_id AND counted.sender_id=c.sender_id AND counted.kind='reply' AND ${prospectReplyCountsSql('counted')} AND counted.started_at>=?) AS day_count,
   (SELECT COUNT(*) FROM workbench_prospect_jobs counted WHERE counted.owner_id=c.owner_id AND counted.sender_id=c.sender_id AND counted.kind='reply' AND ${prospectReplyCountsSql('counted')} AND json_extract(counted.input_json,'$.conversationId')=c.id AND counted.started_at>?) AS conversation_count
   FROM workbench_prospect_conversations c JOIN workbench_prospect_campaigns p ON p.id=c.campaign_id AND p.owner_id=c.owner_id AND p.member_id=c.member_id
   WHERE c.owner_id=? AND c.member_id=? AND c.status='active' AND (c.processing_token IS NULL OR c.processing_until<=?)
    AND EXISTS (SELECT 1 FROM workbench_prospect_messages m WHERE m.conversation_id=c.id AND m.direction='inbound' AND m.eligible=1 AND m.processed=0)
   ORDER BY COALESCE(c.last_checked_at,''),c.last_message_at,c.id LIMIT 100`).bind(dayStart,new Date(now()-86400000).toISOString(),ownerId,memberId,time).all<ConversationRow&{campaign_status:string;campaign_json:string;pending_json:string;last_outbound:string|null;has_reply:number;day_count:number;conversation_count:number}>()).results;
  if(candidates.length)await db.prepare("UPDATE workbench_prospect_conversations SET last_checked_at=? WHERE owner_id=? AND member_id=? AND status='active' AND id IN (SELECT value FROM json_each(?))").bind(time,ownerId,memberId,JSON.stringify(candidates.map(c=>c.id))).run();
  let c:ConversationRow|null=null,stopRequested=false,taskView:TaskMemoryView|undefined;
  for(const candidate of candidates){
   const stop=(JSON.parse(candidate.pending_json) as string[]).some(value=>isChatOptOut(value,candidate.last_outbound??'')),data=object(JSON.parse(candidate.campaign_json)),policy=normalizeChatPolicy(data.chatPolicy);
   if(!stop&&stopOnly)continue;
   if(!stop&&(candidate.mode!=='agent'||!candidate.last_snapshot_id||isTechnicalReadPause(candidate.handoff_reason)))continue;
   if(!stop&&(candidate.campaign_status!=='active'||data.chatEnabled!==true||candidate.has_reply||!withinChatHours(now(),policy)||candidate.day_count>=policy.replyDailyLimit||candidate.conversation_count>=policy.conversationReplyLimit))continue;
   if(!stop)await memoryStore.absorb(ownerId,memberId,candidate.id,(state,messages,options)=>understandTaskMemory(state,messages,options));
   const view=await memoryStore.getView(ownerId,memberId,candidate.id);if(!stop&&!view.ready)continue;
   c=await db.prepare("UPDATE workbench_prospect_conversations SET processing_token=?,processing_until=? WHERE id=? AND version=? AND status='active' AND (processing_token IS NULL OR processing_until<=?) RETURNING *").bind(token,new Date(now()+60000).toISOString(),candidate.id,candidate.version,time).first<ConversationRow>();
   if(c){c.contact_captured=view.state.contact.captured?1:0;taskView=view;stopRequested=stop;break;}
  }
  if(!c||!taskView)return false;
  const unresolved=!!await db.prepare("SELECT id FROM workbench_prospect_jobs WHERE kind='reply' AND status='unknown' AND json_extract(input_json,'$.conversationId')=? LIMIT 1").bind(c.id).first();
  const pending=(await db.prepare(`${messageSelect} WHERE m.conversation_id=? AND m.direction='inbound' AND m.eligible=1 AND m.processed=0 ${stopRequested?'':'AND EXISTS (SELECT 1 FROM workbench_prospect_memory_sources source WHERE source.message_id=m.id AND source.session_id=?) AND m.id NOT IN (SELECT value FROM json_each(?))'} ORDER BY m.created_at,m.rowid LIMIT 100`).bind(c.id,...(stopRequested?[]:[taskView.sessionId,JSON.stringify(taskView.state.ignoredSourceIds)])).all<MessageRow>()).results;
  const inbound=pending.at(-1);
  if(!inbound){await db.prepare('UPDATE workbench_prospect_conversations SET processing_token=NULL,processing_until=NULL WHERE id=? AND processing_token=?').bind(c.id,token).run();return false;}
  const task=await campaign(ownerId,memberId,c.campaign_id),campaignData=object(JSON.parse(task.data_json));const history=await memoryStore.messages(ownerId,memberId,taskView.sessionId,100);
  let decision:ProspectChatDecision;
  try{decision=stopRequested?{action:'wait',close:true,reason:'客户明确要求停止联系'}:decide?await decide(ownerId,origin,{memberId:c.member_id,policy:normalizeChatPolicy(campaignData.chatPolicy),campaign:{name:String(campaignData.name||''),requirements:String(campaignData.requirements||''),minIntentScore:Number(campaignData.minIntentScore||70)},now:stamp(),conversation:{nickname:c.nickname,taskMemory:taskView,memory:projectTaskMemory(taskView.state,stamp()),mode:!unresolved&&campaignData.chatEnabled===true&&task.status==='active'?c.mode:'human'},messages:history,inbound:{id:inbound.id,text:inbound.text,contentType:inbound.content_type},pending:pending.map(m=>({id:m.id,text:m.text,contentType:m.content_type}))}):{action:'handoff',reason:'尚未配置可用的会话模型，已转交销售'};if(!decision||!['reply','handoff','wait'].includes(decision.action))throw new Error('invalid decision');if(decision.action==='reply')sendText(decision.reply);}
  catch{decision={action:'handoff',reason:'会话判断暂时不可用，原消息已保留并转交销售'};}
  if(decision.action==='wait'&&!decision.close&&decision.reason&&!decision.taskMemoryState?.pendingSourceIds?.length)decision={...decision,action:'handoff'};
  const guard='SELECT 1 FROM workbench_prospect_conversations live JOIN workbench_prospect_memory_sessions s ON s.thread_id=live.id JOIN workbench_prospect_memory_bindings b ON b.thread_id=live.id AND b.active_session_id=s.id WHERE live.id=? AND live.version=? AND live.processing_token=? AND s.id=? AND s.write_token=? AND b.version=?',values=[c.id,c.version,token,taskView.sessionId,token,taskView.bindingVersion],statements:D1PreparedStatement[]=[db.prepare(`UPDATE workbench_prospect_memory_sessions SET write_token=? WHERE id=? AND version=? AND source_version=? AND EXISTS (SELECT 1 FROM workbench_prospect_memory_bindings WHERE thread_id=? AND active_session_id=? AND version=?) AND EXISTS (SELECT 1 FROM workbench_prospect_conversations WHERE id=? AND version=? AND processing_token=?) AND EXISTS (SELECT 1 FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1 AND role IN ('sales','manager'))`).bind(token,taskView.sessionId,taskView.sessionVersion,taskView.sourceVersion,c.id,taskView.sessionId,taskView.bindingVersion,c.id,c.version,token,ownerId,memberId)];
  let replyJobId:string|undefined,syncPause:string|undefined;
  if(!decision.close&&!unresolved&&decision.action==='reply'&&c.mode==='agent'&&task.status==='active'&&campaignData.chatEnabled===true&&c.last_snapshot_id){try{const d=await ready(c);const queued=replyStatements(c,d,decision.reply!,'agent',guard,values,{knowledgeLookup:decision.knowledgeLookup,evidenceIds:decision.evidenceIds?.filter(id=>typeof id==='string').slice(0,20),decisionReason:text(decision.reason,500),answeredMessageIds:decision.answeredMessageIds?.filter(id=>pending.some(m=>m.id===id)).slice(0,100)},Number(campaignData.chatPolicyVersion)||0,taskView);replyJobId=queued.jobId;statements.push(...queued.statements);}catch(error){if(error instanceof DomainError&&error.status===503&&temporaryReadyReasons.includes(error.message)){syncPause=`会话同步暂时失败：${error.message}；请稍后重新同步，核实消息后再继续。`;decision={...decision,action:'wait',reason:syncPause};}else decision={...decision,action:'handoff',reason:error instanceof DomainError?error.message:'回复未能可靠排队，请核对助手连接与原会话后人工跟进。'};}}
  if(syncPause)statements.push(db.prepare(`UPDATE workbench_prospect_conversations SET last_snapshot_id=NULL,handoff_reason=? WHERE id=? AND EXISTS (${guard})`).bind(syncPause,c.id,...values));
  const captured=syncPause?null:await captureStatement(c,pending,decision,guard,values);if(captured){statements.push(captured.statement);statements.push(db.prepare(`INSERT OR IGNORE INTO workbench_prospect_memory_captures(session_id,capture_id) SELECT ?,p.id FROM workbench_prospect_lead_pool p WHERE p.owner_id=? AND p.conversation_id=? AND p.contact_key=? AND EXISTS (${guard})`).bind(taskView.sessionId,ownerId,c.id,captured.contactKey,...values));}
  if(!syncPause&&(c.mode==='agent'||decision.close))statements.push(db.prepare(`UPDATE workbench_prospect_messages SET processed=1 WHERE conversation_id=? AND direction='inbound' AND eligible=1 AND processed=0 AND rowid<=? AND id IN (SELECT message_id FROM workbench_prospect_memory_sources WHERE session_id=?) AND EXISTS (${guard})`).bind(c.id,inbound.row_order,taskView.sessionId,...values));
  const memory=normalizeChatMemory(syncPause?JSON.parse(c.memory_json||'{}'):decision.memory??JSON.parse(c.memory_json||'{}'));
  if(decision.close)statements.push(...closeStatements(c,text(safeProspectError(decision.reason),500)||'客户要求停止联系',memory,guard,values));
  const handoff=decision.action==='handoff'||unresolved;if(handoff&&!decision.close)memory.stage='handoff';if(captured||c.contact_captured)memory.contactCaptured=true;if(unresolved)decision.reason='上一条回复结果待确认，已保留人工接管';
  statements.push(db.prepare(`UPDATE workbench_prospect_conversations SET memory_json=?,status=CASE WHEN ?=1 THEN 'closed' ELSE status END,close_reason=CASE WHEN ?=1 THEN ? ELSE close_reason END,mode=CASE WHEN ?=1 THEN 'human' ELSE mode END,handoff_reason=CASE WHEN ?=1 THEN ? ELSE handoff_reason END,version=version+1,processing_token=NULL,processing_until=NULL,updated_at=? WHERE id=? AND EXISTS (${guard})`).bind(JSON.stringify({...memory,...(object(JSON.parse(c.memory_json||'{}')).legacyRecoveredInboundId?{legacyRecoveredInboundId:object(JSON.parse(c.memory_json||'{}')).legacyRecoveredInboundId}:{}),lastDecision:{knowledgeLookup:decision.knowledgeLookup,action:decision.action,inboundId:inbound.id,queued:!!replyJobId,snapshotId:c.last_snapshot_id,at:stamp()}}),decision.close?1:0,decision.close?1:0,text(safeProspectError(decision.reason),500)||'客户要求停止联系',handoff?1:0,handoff?1:0,text(safeProspectError(decision.reason),500)||'已转交销售',stamp(),c.id,...values));
  try{const results=await db.batch(statements);if(!results.at(-1)?.meta.changes){await db.prepare('UPDATE workbench_prospect_conversations SET processing_token=NULL,processing_until=NULL WHERE id=? AND processing_token=?').bind(c.id,token).run();return true;}
   if(replyJobId){const queued=await db.prepare('SELECT id FROM workbench_prospect_jobs WHERE id=?').bind(replyJobId).first();if(!queued)await db.prepare("UPDATE workbench_prospect_conversations SET mode='human',memory_json=json_set(memory_json,'$.stage','handoff'),handoff_reason='助手身份已改变，未排队回复',version=version+1 WHERE id=?").bind(c.id).run();}
   return true;
  }catch(error){await db.prepare("UPDATE workbench_prospect_conversations SET mode='human',memory_json=json_set(memory_json,'$.stage','handoff'),handoff_reason='回复未能可靠排队，已转交销售',processing_token=NULL,processing_until=NULL,version=version+1,updated_at=? WHERE id=? AND processing_token=?").bind(stamp(),c.id,token).run();throw error;}
 }
 return{materialize,snapshot,settings,waitingCancellation,takeover,resume,reply,sync,hasQueuedManualSync,hasQueuedConversationWork,schedule,assertJob,complete,processOne,rememberOne,memoryView,memoryEdit,switchTask,assertActiveCampaign};
}
