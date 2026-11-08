import {DomainError} from './domain.ts';
import {normalizeChatMemory} from './prospecting-chat-policy.ts';
import {emptyTaskMemory,advanceTaskMemory,editTaskMemory} from './prospecting-memory.ts';
import type {TaskMemoryView,TaskMemoryState,TaskMemoryMessage,TaskMemoryOptions,TaskMemoryEdit} from './prospecting-memory-types.ts';

type Thread={id:string;owner_id:string;member_id:string;campaign_id:string;version:number;memory_json:string;sender_id:string;recipient_id:string};
type Session={id:string;thread_id:string;campaign_id:string;owner_id:string;member_id:string;version:number;source_watermark:number;source_version:number;state_json:string};
type Binding={active_session_id:string;original_session_id:string;version:number;legacy_watermark:number};
type View=TaskMemoryView & {threadId:string;threadVersion:number;sourceWatermark:number;sourceVersion:number};
type RawMessage={id:string;conversation_id:string;direction:TaskMemoryMessage['direction'];actor:TaskMemoryMessage['actor'];text:string;status:TaskMemoryMessage['status'];posted_at:string|null;created_at:string;row_order:number;job_status:string|null;job_result_json:string|null;job_id:string|null;job_actor:string|null;answer_ids_json:string|null;legacy_budget_covered:number};
const conflict=()=>new DomainError('会话或任务记忆已更新，请刷新后重试',409);
const allowed=`EXISTS (SELECT 1 FROM workbench_member_accounts a WHERE a.owner_id=s.owner_id AND a.account_id=s.member_id AND a.enabled=1 AND a.role IN ('sales','manager')) AND EXISTS (SELECT 1 FROM workbench_prospect_campaigns p WHERE p.id=s.campaign_id AND p.owner_id=s.owner_id AND p.member_id=s.member_id)`;
const uncertain=`EXISTS (SELECT 1 FROM workbench_prospect_jobs j WHERE j.owner_id=c.owner_id AND j.sender_id=c.sender_id AND j.kind IN ('send','reply') AND j.status IN ('running','unknown') AND json_extract(j.input_json,'$.recipientId')=c.recipient_id)`;
const latest=`COALESCE((SELECT MAX(ms.row_order) FROM workbench_prospect_memory_sources ms WHERE ms.session_id=s.id),0)`;
const messageSelect=`SELECT m.*,x.row_order,(x.session_id=(SELECT original_session_id FROM workbench_prospect_memory_bindings WHERE thread_id=m.conversation_id) AND x.row_order<=(SELECT legacy_watermark FROM workbench_prospect_memory_bindings WHERE thread_id=m.conversation_id)) AS legacy_budget_covered,j.status AS job_status,j.result_json AS job_result_json,json_extract(j.input_json,'$.actor') AS job_actor,json_extract(j.input_json,'$.answeredMessageIds') AS answer_ids_json FROM workbench_prospect_memory_sources x JOIN workbench_prospect_messages m ON m.id=x.message_id LEFT JOIN workbench_prospect_jobs j ON j.id=m.job_id`;
function message(r:RawMessage):TaskMemoryMessage {
 const status=r.job_status==='done'?'sent':r.job_status==='running'?'sending':r.job_status&&['failed','unknown','cancelled'].includes(r.job_status)?r.job_status:r.status;
 return {id:r.id,conversationId:r.conversation_id,direction:r.direction,actor:r.actor,text:r.text,status:status as TaskMemoryMessage['status'],createdAt:r.created_at,...(r.posted_at?{postedAt:r.posted_at}:{}),rowOrder:r.row_order,legacyBudgetCovered:!!r.legacy_budget_covered,...(r.answer_ids_json?{answeredMessageIds:(JSON.parse(r.answer_ids_json) as unknown[]).filter((id):id is string=>typeof id==='string').slice(0,100)}:{}),actorVerified:!!r.job_id&&r.job_actor===r.actor} as TaskMemoryMessage;
}
/** D1 batch is transactional. Every write is guarded inside its statement, never by a prior read alone. */
export function createProspectMemoryStore(db:D1Database,now:()=>number=Date.now){
 const stamp=()=>new Date(now()).toISOString();
 async function auth(ownerId:string,memberId:string){if(!await db.prepare("SELECT 1 FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1 AND role IN ('sales','manager')").bind(ownerId,memberId).first())throw new DomainError('业务账号已停用或无权操作',403);}
 async function thread(ownerId:string,memberId:string,id:string){await auth(ownerId,memberId);const r=await db.prepare('SELECT * FROM workbench_prospect_conversations WHERE id=? AND owner_id=? AND member_id=?').bind(id,ownerId,memberId).first<Thread>();if(!r)throw new DomainError('会话不存在或无权操作',404);return r;}
 async function campaign(ownerId:string,memberId:string,id:string){if(!await db.prepare('SELECT 1 FROM workbench_prospect_campaigns WHERE id=? AND owner_id=? AND member_id=?').bind(id,ownerId,memberId).first())throw new DomainError('获客任务不存在或无权操作',404);}
 async function init(t:Thread){
  const sid=`task:${t.id}:${t.campaign_id}`,time=stamp(),initToken=crypto.randomUUID();
  const state=emptyTaskMemory(normalizeChatMemory(t.memory_json));
  // Only the original task may inherit legacy contact state. Never consult the global pool for a new task.
  if(await db.prepare('SELECT 1 FROM workbench_prospect_lead_pool WHERE owner_id=? AND conversation_id=? LIMIT 1').bind(t.owner_id,t.id).first())state.contact.captured=true;
  await db.batch([
   db.prepare(`INSERT OR IGNORE INTO workbench_prospect_memory_sessions (id,thread_id,campaign_id,owner_id,member_id,state_json,write_token,created_at,updated_at) SELECT ?,c.id,c.campaign_id,c.owner_id,c.member_id,?,?,?,? FROM workbench_prospect_conversations c WHERE c.id=? AND c.owner_id=? AND c.member_id=? AND c.campaign_id=? AND NOT EXISTS (SELECT 1 FROM workbench_prospect_memory_bindings WHERE thread_id=c.id)`).bind(sid,JSON.stringify(state),initToken,time,time,t.id,t.owner_id,t.member_id,t.campaign_id),
   db.prepare(`INSERT OR IGNORE INTO workbench_prospect_memory_bindings (thread_id,active_session_id,original_session_id,legacy_verified_at,legacy_watermark,updated_at) SELECT s.thread_id,s.id,s.id,(SELECT last_read_at FROM workbench_prospect_conversations WHERE id=s.thread_id),COALESCE((SELECT MAX(m.rowid) FROM workbench_prospect_messages m WHERE m.conversation_id=s.thread_id AND m.owner_id=s.owner_id AND m.member_id=s.member_id),0),? FROM workbench_prospect_memory_sessions s WHERE s.id=? AND ${allowed}`).bind(time,sid),
   db.prepare(`INSERT OR IGNORE INTO workbench_prospect_memory_captures (session_id,capture_id) SELECT b.original_session_id,p.id FROM workbench_prospect_memory_bindings b JOIN workbench_prospect_lead_pool p ON p.conversation_id=b.thread_id JOIN workbench_prospect_memory_sessions original ON original.id=b.original_session_id WHERE b.thread_id=? AND p.owner_id=? AND original.write_token=?`).bind(t.id,t.owner_id,initToken),
  ]);
  // Fixed pre-migration boundary prevents later unassigned messages being guessed into the old task.
  await db.prepare(`INSERT OR IGNORE INTO workbench_prospect_memory_sources (message_id,session_id,binding_version,row_order,created_at) SELECT m.id,s.id,1,m.rowid,? FROM workbench_prospect_memory_bindings b JOIN workbench_prospect_memory_sessions s ON s.id=b.original_session_id JOIN workbench_prospect_messages m ON m.conversation_id=s.thread_id AND m.owner_id=s.owner_id AND m.member_id=s.member_id WHERE b.thread_id=? AND m.rowid<=b.legacy_watermark AND m.eligible>=0 AND ((b.legacy_verified_at IS NOT NULL AND m.created_at<=b.legacy_verified_at) OR EXISTS (SELECT 1 FROM workbench_prospect_jobs proof WHERE proof.id=m.job_id AND proof.status='done')) AND ${allowed} AND NOT EXISTS (SELECT 1 FROM workbench_prospect_memory_sources x WHERE x.message_id=m.id) ORDER BY m.rowid LIMIT 40`).bind(time,t.id).run();
 }
 async function getView(ownerId:string,memberId:string,threadId:string,campaignId?:string):Promise<View>{
  const t=await thread(ownerId,memberId,threadId);await campaign(ownerId,memberId,campaignId??t.campaign_id);await init(t);
  const b=(await db.prepare('SELECT * FROM workbench_prospect_memory_bindings WHERE thread_id=?').bind(threadId).first<Binding>())!;
  const wanted=campaignId??t.campaign_id;
  const sid=`task:${t.id}:${wanted}`;
  await db.prepare(`INSERT OR IGNORE INTO workbench_prospect_memory_sessions (id,thread_id,campaign_id,owner_id,member_id,state_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(sid,t.id,wanted,ownerId,memberId,JSON.stringify(emptyTaskMemory()),stamp(),stamp()).run();
  const s=(await db.prepare('SELECT * FROM workbench_prospect_memory_sessions WHERE thread_id=? AND campaign_id=? AND owner_id=? AND member_id=?').bind(threadId,wanted,ownerId,memberId).first<Session>())!;
  if(!s)throw new DomainError('任务接待不存在',404);
  const max=(await db.prepare('SELECT COALESCE(MAX(row_order),0) AS n FROM workbench_prospect_memory_sources WHERE session_id=?').bind(s.id).first<{n:number}>())!.n;
  const active=await db.prepare('SELECT campaign_id FROM workbench_prospect_memory_sessions WHERE id=? AND owner_id=? AND member_id=?').bind(b.active_session_id,ownerId,memberId).first<{campaign_id:string}>();
  const pendingLegacy=b.original_session_id===s.id&&!!await db.prepare(`SELECT 1 FROM workbench_prospect_messages m WHERE m.conversation_id=? AND m.owner_id=? AND m.member_id=? AND m.rowid<=? AND NOT EXISTS (SELECT 1 FROM workbench_prospect_memory_sources x WHERE x.message_id=m.id) LIMIT 1`).bind(threadId,ownerId,memberId,b.legacy_watermark).first();
  const pendingSources=!!await db.prepare(`SELECT 1 FROM workbench_prospect_memory_sources x JOIN workbench_prospect_messages m ON m.id=x.message_id LEFT JOIN workbench_prospect_jobs j ON j.id=m.job_id WHERE x.session_id=? AND (x.processed_status IS NULL OR (m.direction='outbound' AND x.processed_status!=COALESCE(j.status,m.status))) LIMIT 1`).bind(s.id).first();
  const state=JSON.parse(s.state_json) as TaskMemoryState;
  return{sessionId:s.id,threadId,campaignId:wanted,activeCampaignId:active?.campaign_id??null,isActive:b.active_session_id===s.id,sessionVersion:s.version,bindingVersion:b.version,threadVersion:t.version,sourceWatermark:max,sourceVersion:s.source_version,state,ready:!pendingLegacy&&!pendingSources&&state.sourceWatermark>=max&&!(state.pendingSourceIds?.length)};
 }
 async function session(ownerId:string,memberId:string,id:string){await auth(ownerId,memberId);const s=await db.prepare(`SELECT s.* FROM workbench_prospect_memory_sessions s JOIN workbench_prospect_conversations c ON c.id=s.thread_id AND c.owner_id=s.owner_id AND c.member_id=s.member_id WHERE s.id=? AND s.owner_id=? AND s.member_id=? AND ${allowed}`).bind(id,ownerId,memberId).first<Session>();if(!s)throw new DomainError('任务接待不存在或无权操作',404);return s;}
 async function messages(ownerId:string,memberId:string,sessionId:string,limit=40):Promise<TaskMemoryMessage[]>{
  const s=await session(ownerId,memberId,sessionId);const ignored=(JSON.parse(s.state_json) as TaskMemoryState).ignoredSourceIds;
  const rows=(await db.prepare(`${messageSelect} WHERE x.session_id=? AND NOT EXISTS (SELECT 1 FROM json_each(?) ignored WHERE ignored.value=m.id) ORDER BY x.row_order DESC LIMIT ?`).bind(sessionId,JSON.stringify(ignored),Math.max(1,Math.min(100,limit))).all<RawMessage>()).results;
  return rows.reverse().map(message).map(redact);
 }
 function redact(m:TaskMemoryMessage):TaskMemoryMessage{return{...m,text:m.text.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[联系方式已脱敏]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[联系方式已脱敏]').replace(/((?:微信|wechat|wx|手机号|电话|联系方式)\s*[:：号是为]?\s*)[a-zA-Z0-9_+@.-]{5,}/gi,'$1[联系方式已脱敏]')};}
 function attributeMessage(messageId:string,view:TaskMemoryView,guard='1',values:unknown[]=[],freshProof?:{freshAfterBaselineGuard:string;values?:unknown[]}):D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO workbench_prospect_memory_sources (message_id,session_id,binding_version,row_order,created_at) SELECT m.id,s.id,b.version,m.rowid,? FROM workbench_prospect_messages m JOIN workbench_prospect_memory_sessions s ON s.id=? AND s.thread_id=m.conversation_id AND s.owner_id=m.owner_id AND s.member_id=m.member_id JOIN workbench_prospect_memory_bindings b ON b.thread_id=s.thread_id AND b.active_session_id=s.id JOIN workbench_prospect_conversations c ON c.id=s.thread_id AND c.campaign_id=s.campaign_id AND c.owner_id=s.owner_id AND c.member_id=s.member_id WHERE m.id=? AND b.version=? AND (b.version=1 OR (m.rowid>b.switched_watermark AND ((m.posted_at IS NOT NULL AND julianday(m.posted_at)>julianday(b.updated_at)) OR (${freshProof?.freshAfterBaselineGuard??'0'})))) AND ${allowed} AND (${guard})`).bind(stamp(),view.sessionId,messageId,view.bindingVersion,...(freshProof?.values??[]),...values);
 }
 async function saveState(ownerId:string,memberId:string,view:TaskMemoryView,nextState:TaskMemoryState,invalidate=false,consumed:RawMessage[]=[]):Promise<boolean>{
  await session(ownerId,memberId,view.sessionId);
  const token=crypto.randomUUID(),payload=JSON.stringify(nextState),time=stamp();
  const statements=[db.prepare(`UPDATE workbench_prospect_memory_sessions AS s SET state_json=?,source_watermark=?,version=version+1,write_token=?,updated_at=? WHERE s.id=? AND s.owner_id=? AND s.member_id=? AND s.version=? AND s.source_version=? AND ${latest}=? AND EXISTS (SELECT 1 FROM workbench_prospect_memory_bindings b WHERE b.thread_id=s.thread_id AND b.version=?) AND ${allowed}`).bind(payload,nextState.sourceWatermark,token,time,view.sessionId,ownerId,memberId,view.sessionVersion,(view as View).sourceVersion,view.sourceWatermark??view.state.sourceWatermark,view.bindingVersion)];
  for(const f of nextState.facts)statements.push(db.prepare(`INSERT INTO workbench_prospect_memory_facts (session_id,id,source_message_id,status,data_json) SELECT id,?,?,?,? FROM workbench_prospect_memory_sessions WHERE id=? AND write_token=? ON CONFLICT(session_id,id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json`).bind(f.id,f.sourceMessageId,f.status,JSON.stringify(f),view.sessionId,token));
  for(const e of nextState.events)statements.push(db.prepare(`INSERT INTO workbench_prospect_memory_events (session_id,id,source_message_id,created_at,data_json) SELECT id,?,?,?,? FROM workbench_prospect_memory_sessions WHERE id=? AND write_token=? ON CONFLICT(session_id,id) DO UPDATE SET data_json=excluded.data_json`).bind(e.id,e.sourceMessageId,e.sourceAt,JSON.stringify(e),view.sessionId,token));
  for(const m of consumed)statements.push(db.prepare(`UPDATE workbench_prospect_memory_sources SET processed_status=? WHERE message_id=? AND session_id=? AND EXISTS (SELECT 1 FROM workbench_prospect_memory_sessions WHERE id=? AND write_token=?)`).bind(m.job_status??m.status,m.id,view.sessionId,view.sessionId,token));
  if(invalidate)statements.push(db.prepare(`UPDATE workbench_prospect_conversations SET version=version+1,processing_token=NULL,processing_until=NULL,updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM workbench_prospect_memory_sessions WHERE id=? AND write_token=?) AND EXISTS (SELECT 1 FROM workbench_prospect_memory_bindings WHERE thread_id=? AND version=? AND active_session_id=?)`).bind(time,view.threadId,view.sessionId,token,view.threadId,view.bindingVersion,view.sessionId),...cancel(view.threadId!,view.campaignId,token));
  const result=await db.batch(statements);return Number(result[0].meta.changes)>0;
 }
 async function absorb(ownerId:string,memberId:string,threadId:string,remember?:(state:TaskMemoryState,messages:TaskMemoryMessage[],options:TaskMemoryOptions)=>Promise<TaskMemoryState>):Promise<boolean>{
  const view=await getView(ownerId,memberId,threadId);
  const raw=(await db.prepare(`${messageSelect} WHERE x.session_id=? AND (x.row_order>? OR x.processed_status IS NULL OR EXISTS (SELECT 1 FROM json_each(?) pending WHERE pending.value=m.id)) ORDER BY x.row_order LIMIT 40`).bind(view.sessionId,view.state.sourceWatermark,JSON.stringify(view.state.pendingSourceIds??[])).all<RawMessage>()).results;
  const outbound=(await db.prepare(`${messageSelect} WHERE x.session_id=? AND m.direction='outbound' AND (x.processed_status IS NULL OR x.processed_status!=COALESCE(j.status,m.status)) ORDER BY x.row_order LIMIT 40`).bind(view.sessionId).all<RawMessage>()).results;
  if(!raw.length&&!outbound.length&&!view.state.pendingSourceIds?.length)return false;
  const recent=outbound.map(message).filter(m=>!view.state.ignoredSourceIds.includes(m.id));
  const ignored=new Set(view.state.ignoredSourceIds);const incoming=raw.map(message).filter(m=>!ignored.has(m.id));
  const all=[...new Map([...recent,...incoming].map(m=>[m.id,m])).values()].sort((a,b)=>(a.rowOrder??0)-(b.rowOrder??0));
  const next=await (remember??(async(s,m,o)=>advanceTaskMemory(s,m,o)))(structuredClone(view.state),all,{now:stamp(),timeZone:'Asia/Shanghai'});
  next.sourceWatermark=next.pendingSourceIds?.length?view.state.sourceWatermark:raw.length?Math.max(view.state.sourceWatermark,raw[raw.length-1].row_order):view.state.sourceWatermark;
  return saveState(ownerId,memberId,view,next,false,[...raw,...outbound]);
 }
 function cancel(threadId:string,campaignId:string,token:string){return [
  db.prepare(`UPDATE workbench_prospect_jobs SET status='cancelled',active_key=NULL,lease_hash=NULL,lease_until=NULL,error='任务记忆或接待任务已更新',updated_at=? WHERE campaign_id=? AND kind='reply' AND status IN ('queued','waiting') AND json_extract(input_json,'$.conversationId')=? AND EXISTS (SELECT 1 FROM workbench_prospect_memory_sessions WHERE thread_id=? AND write_token=?)`).bind(stamp(),campaignId,threadId,threadId,token),
  db.prepare(`UPDATE workbench_prospect_messages SET status='cancelled' WHERE conversation_id=? AND status IN ('queued','waiting') AND (job_id IN (SELECT id FROM workbench_prospect_jobs WHERE campaign_id=? AND status='cancelled') OR id IN (SELECT message_id FROM workbench_prospect_memory_sources WHERE session_id IN (SELECT id FROM workbench_prospect_memory_sessions WHERE thread_id=? AND campaign_id=?))) AND EXISTS (SELECT 1 FROM workbench_prospect_memory_sessions WHERE thread_id=? AND write_token=?)`).bind(threadId,campaignId,threadId,campaignId,threadId,token),
 ];}
 async function mutate(ownerId:string,memberId:string,threadId:string,campaignId:string,sessionVersion:number,bindingVersion:number,change:TaskMemoryEdit):Promise<View>{
  const v=await getView(ownerId,memberId,threadId,campaignId);if(v.sessionVersion!==sessionVersion||v.bindingVersion!==bindingVersion)throw conflict();
  const next=editTaskMemory(v.state,{...change,actorId:memberId,now:stamp()});
  // Even an idempotent ignored edit carries a source suppression and an audit event from the domain.
  if(!await saveState(ownerId,memberId,v,next,v.isActive))throw conflict();
  return getView(ownerId,memberId,threadId,campaignId);
 }
 async function switchTask(ownerId:string,memberId:string,threadId:string,targetCampaignId:string,threadVersion:number,bindingVersion:number):Promise<View>{
  const old=await getView(ownerId,memberId,threadId);await campaign(ownerId,memberId,targetCampaignId);
  const target=await getView(ownerId,memberId,threadId,targetCampaignId);if(old.threadVersion!==threadVersion||old.bindingVersion!==bindingVersion)throw conflict();
  if(old.sessionId===target.sessionId)return target;
  const token=crypto.randomUUID(),time=stamp();
  const out=await db.batch([
   db.prepare(`UPDATE workbench_prospect_conversations AS c SET campaign_id=?,version=version+1,last_snapshot_id=NULL,has_baseline=0,last_read_at=NULL,processing_token=NULL,processing_until=NULL,memory_json=?,updated_at=? WHERE c.id=? AND c.owner_id=? AND c.member_id=? AND c.version=? AND NOT ${uncertain} AND EXISTS (SELECT 1 FROM workbench_prospect_memory_bindings b WHERE b.thread_id=c.id AND b.version=? AND b.active_session_id=?) AND EXISTS (SELECT 1 FROM workbench_prospect_memory_sessions s WHERE s.id=? AND s.owner_id=c.owner_id AND s.member_id=c.member_id AND ${allowed})`).bind(targetCampaignId,'{}',time,threadId,ownerId,memberId,threadVersion,bindingVersion,old.sessionId,target.sessionId),
   db.prepare(`UPDATE workbench_prospect_memory_sessions SET write_token=? WHERE id=? AND EXISTS (SELECT 1 FROM workbench_prospect_conversations WHERE id=? AND version=? AND campaign_id=?) AND EXISTS (SELECT 1 FROM workbench_prospect_memory_bindings WHERE thread_id=? AND version=?)`).bind(token,old.sessionId,threadId,threadVersion+1,targetCampaignId,threadId,bindingVersion),
   db.prepare(`UPDATE workbench_prospect_memory_bindings SET active_session_id=?,version=version+1,switched_watermark=COALESCE((SELECT MAX(rowid) FROM workbench_prospect_messages WHERE conversation_id=?),0),updated_at=? WHERE thread_id=? AND version=? AND EXISTS (SELECT 1 FROM workbench_prospect_memory_sessions WHERE id=? AND write_token=?)`).bind(target.sessionId,threadId,time,threadId,bindingVersion,old.sessionId,token),...cancel(threadId,old.campaignId,token),
  ]);
  if(!Number(out[0].meta.changes))throw conflict();return getView(ownerId,memberId,threadId,targetCampaignId);
 }
 async function sessions(ownerId:string,memberId:string,threadId:string):Promise<View[]>{await getView(ownerId,memberId,threadId);const rows=(await db.prepare('SELECT s.campaign_id FROM workbench_prospect_memory_sessions s WHERE s.thread_id=? AND s.owner_id=? AND s.member_id=? AND '+allowed).bind(threadId,ownerId,memberId).all<{campaign_id:string}>()).results;return Promise.all(rows.map(s=>getView(ownerId,memberId,threadId,s.campaign_id)));}
 return{getView,messages,attributeMessage,saveState,absorb,mutate,switchTask,sessions};
}
