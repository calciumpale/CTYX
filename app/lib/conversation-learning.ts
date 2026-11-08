import {DomainError} from './domain.ts';
import {knowledgeDepartmentForSalesId} from './knowledge-department-scope.ts';
import type {KnowledgeDepartmentId} from './knowledge-department-scope.ts';
import type {WorkbenchState} from './types.ts';
import type {FeedbackJob} from './talktrack-types.ts';
export interface ConversationSource {ownerId:string;memberId:string;employeeId:string;employeeName:string;departmentId:KnowledgeDepartmentId;conversationId:string;campaignId:string;sessionId:string;capturedAt:string;sourceHash?:string;messages:{id:string;direction:string;text:string}[];}
export function redactConversationText(value:string,names:string[]=[]):string{
 let text=value;for(const name of names.filter(n=>n.trim().length>=2))text=text.split(name).join('[姓名已隐藏]');
 // Consume complete labels and introducers before matching the actual identifier.
 return text
  .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[邮箱已隐藏]')
  .replace(/(?:联系电话|手机号码?|电话号码?|联系方式|手机|电话|tel(?:ephone)?)\s*(?:[:：=]|是|为)?\s*[+＋]?\d[\d\s()（）-]{5,24}\d/gi,'[电话已隐藏]')
  .replace(/(?:微信号|微信|微号|v信|wechat|weixin|wx(?:号)?|vx(?:号)?|抖音号|账号|帐号)\s*(?:(?:是|为|[:：=])\s*)*(?:[a-zA-Z][a-zA-Z0-9_-]{3,29}|\d{5,20})/gi,'[联系方式已隐藏]')
  .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?!\d)/g,'[电话已隐藏]')
  .replace(/(?:姓名|联系人)\s*(?:(?:是|为|[:：=])\s*)*(?:[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z'-]{0,39}(?:[ \t]+[A-Za-z][A-Za-z'-]{0,39}){0,3})/g,'[姓名已隐藏]')
  .replace(/\[(?:客户|姓名|电话|微信|联系人|联系方式)[^\]]*\]/g,'[联系方式已隐藏]');
}
type Raw={id:string;direction:string;actor:string;status:string;text:string;content_type?:string};
export async function conversationSnapshot(source:ConversationSource,rows:Raw[],names:string[]=[]):Promise<ConversationSource>{
 const messages:ConversationSource['messages']=[];let length=0;
 for(const row of rows){if(row.content_type==='image'||!(row.direction==='inbound'&&row.status==='received'||row.direction==='outbound'&&row.status==='sent'&&['agent','human'].includes(row.actor)))continue;
 const text=redactConversationText(row.text,names).trim();const substance=text.replace(/\[[^\]]*\]/g,'').replace(/[\s\p{P}]/gu,'');if(substance.length<8||/^(好的|收到|谢谢|可以|嗯|了解|没问题)+$/u.test(substance))continue;
 if(messages.length>=100||length+text.length>50000)break;messages.push({id:row.id,direction:row.direction,text});length+=text.length;}
 if(messages.filter(m=>m.direction==='inbound').length<2||messages.filter(m=>m.direction==='outbound').length<2)throw new DomainError('至少需要两轮实质客户文本和两轮已确认发送的回复，图片、草稿和简单确认不计入',409);
 const snapshot={...source,messages};const bytes=new TextEncoder().encode(JSON.stringify([source.ownerId,source.memberId,source.departmentId,source.conversationId,source.campaignId,source.sessionId,messages]));snapshot.sourceHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');return snapshot;
}
/** Read only persisted, task-bound messages. The actor's role is read again from DB. */
export async function captureConversation(db:D1Database,ownerId:string,actorId:string,conversationId:string,campaignId:string){
 const actor=await db.prepare('SELECT role FROM workbench_member_accounts WHERE owner_id=? AND account_id=? AND enabled=1').bind(ownerId,actorId).first<{role:string}>();if(!actor||!['sales','manager'].includes(actor.role))throw new DomainError('无权提炼会话',403);
 const row=await db.prepare(`SELECT c.member_id,c.nickname,a.sales_id,a.display_name,s.id AS session_id FROM workbench_prospect_conversations c JOIN workbench_member_accounts a ON a.account_id=c.member_id AND a.owner_id=c.owner_id AND a.enabled=1 AND a.role='sales' JOIN workbench_prospect_memory_bindings b ON b.thread_id=c.id JOIN workbench_prospect_memory_sessions s ON s.id=b.active_session_id AND s.thread_id=c.id AND s.owner_id=c.owner_id AND s.member_id=c.member_id AND s.campaign_id=c.campaign_id JOIN workbench_prospect_campaigns p ON p.id=c.campaign_id AND p.owner_id=c.owner_id AND p.member_id=c.member_id WHERE c.id=? AND c.owner_id=? AND c.campaign_id=?`).bind(conversationId,ownerId,campaignId).first<{member_id:string;nickname:string;sales_id:string;display_name:string;session_id:string}>();
 if(!row||actor.role==='sales'&&row.member_id!==actorId)throw new DomainError('会话不存在或无权提炼',404);const departmentId=knowledgeDepartmentForSalesId(row.sales_id);if(!departmentId)throw new DomainError('来源销售尚未归属部门',409);
 const messages=await db.prepare(`SELECT m.id,m.direction,m.actor,m.text,m.content_type,CASE WHEN j.status='done' THEN 'sent' WHEN j.status IS NOT NULL AND m.direction='outbound' THEN j.status ELSE m.status END AS status FROM workbench_prospect_memory_sources x JOIN workbench_prospect_messages m ON m.id=x.message_id LEFT JOIN workbench_prospect_jobs j ON j.id=m.job_id AND j.owner_id=m.owner_id AND j.member_id=m.member_id WHERE x.session_id=? AND m.owner_id=? AND m.member_id=? AND m.conversation_id=? ORDER BY x.row_order DESC LIMIT 500`).bind(row.session_id,ownerId,row.member_id,conversationId).all<Raw>();
 return conversationSnapshot({ownerId,memberId:row.member_id,employeeId:row.sales_id,employeeName:row.display_name,departmentId,conversationId,campaignId,sessionId:row.session_id,capturedAt:new Date().toISOString(),messages:[]},messages.results.reverse(),[row.nickname,row.display_name]);
}
export function queueConversationLearning(state:WorkbenchState,source:ConversationSource):FeedbackJob{
 const jobs=state.feedbackJobs??=[];const existing=jobs.find(j=>j.conversationSource?.sourceHash===source.sourceHash&&j.conversationSource?.conversationId===source.conversationId);
 if(existing){if(['waiting_config','failed'].includes(existing.status)){existing.status='queued';existing.message='等待重新提炼对话案例';}return existing;}
 const running=jobs.find(j=>j.conversationSource?.conversationId===source.conversationId&&j.conversationSource?.campaignId===source.campaignId&&j.status==='running'&&Date.parse(j.leaseUntil??'')>Date.now());if(running)return running;
 if(jobs.length>=1000||jobs.reduce((n,j)=>n+JSON.stringify(j.conversationSource??{}).length,0)+JSON.stringify(source).length>2000000)throw new DomainError('对话案例存储容量已满，请联系管理员',413);
 const job:FeedbackJob={id:`conversation-learning-${crypto.randomUUID()}`,dealId:'',departmentId:source.departmentId,conversationSource:source,sourceHash:source.sourceHash!,status:'queued',message:'对话案例已脱敏保存，等待提炼；不代表已成单',candidateIds:[],createdAt:source.capturedAt,updatedAt:source.capturedAt};jobs.unshift(job);return job;
}
