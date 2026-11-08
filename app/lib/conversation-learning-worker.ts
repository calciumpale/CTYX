import {DomainError} from './domain.ts';
import {queueConversationLearning,redactConversationText} from './conversation-learning.ts';
import type {ConversationSource} from './conversation-learning.ts';
import type {WorkbenchState} from './types.ts';
import type {CallTranscript,TalkTrackDraft,FeedbackJob} from './talktrack-types.ts';
import {talkTitle,talkText} from './talktrack-domain.ts';
interface Dependencies {load:()=>Promise<WorkbenchState>;save:(revision:number,state:WorkbenchState)=>Promise<void>;generate?: (sources:CallTranscript[])=>Promise<TalkTrackDraft[]>;}
const conflict=(error:unknown)=>error instanceof DomainError&&error.status===409;
/** CAS claims prevent concurrent requests from generating twice. Source is persisted first. */
export async function learnConversation(source:ConversationSource,deps:Dependencies):Promise<FeedbackJob>{
 let jobId='';for(let attempt=0;attempt<3;attempt++){const state=await deps.load();const revision=state.revision;const job=queueConversationLearning(state,source);jobId=job.id;state.revision++;try{await deps.save(revision,state);break;}catch(error){if(!conflict(error)||attempt===2)throw error;}}
 let job:FeedbackJob|undefined;const token=crypto.randomUUID();
 for(let attempt=0;attempt<3;attempt++){
  const state=await deps.load();job=state.feedbackJobs!.find(j=>j.id===jobId)!;
  if(!['queued','waiting_config','failed'].includes(job.status)&&!(job.status==='running'&&Date.parse(job.leaseUntil??'')<Date.now()))return job;
  const revision=state.revision;state.revision++;job.updatedAt=new Date().toISOString();
  if(!deps.generate){job.status='waiting_config';job.message='对话案例已保存；请配置并启用大模型后，在原会话再次点击提炼话术 Skill';delete job.leaseToken;delete job.leaseUntil;}
  else{job.status='running';job.message='正在从脱敏对话案例提炼候选话术';job.leaseToken=token;job.leaseUntil=new Date(Date.now()+180000).toISOString();}
  try{await deps.save(revision,state);if(!deps.generate)return job;break;}
  catch(error){if(!conflict(error)||attempt===2)throw error;}
 }
 if(!job||!deps.generate)throw new DomainError('提炼任务未能取得处理权，请重试',409);
 try{
 const saved=job.conversationSource!;const transcripts:CallTranscript[]=[{id:`source-${job.id}`,dealId:'',employeeId:saved.employeeId,employeeName:saved.employeeName,text:saved.messages.map(m=>`${m.direction==='inbound'?'客户':'销售'}：${m.text}`).join('\n'),source:'pasted',createdAt:saved.capturedAt}];
 const drafts=await deps.generate(transcripts);
 for(let attempt=0;attempt<3;attempt++){const latest=await deps.load();const current=latest.feedbackJobs?.find(j=>j.id===jobId);if(!current||current.leaseToken!==token||current.sourceHash!==job.sourceHash||Date.parse(current.leaseUntil??'')<=Date.now())return current??job;
 const now=new Date().toISOString();const accepted=drafts.slice(0,3).filter(d=>d.evidence.length>0&&d.evidence.every(e=>e.transcriptId===transcripts[0].id&&transcripts[0].text.includes(e.quote)));
 const tracks=accepted.filter(d=>!(latest.talkTracks??[]).some(t=>t.departmentId===saved.departmentId&&['candidate','published'].includes(t.status)&&talkText(t)===talkText(d))).map(d=>{
 // Model output may introduce identifiers; evidence remains exact against retained source.
 const clean={...d,topic:redactConversationText(d.topic),scenario:redactConversationText(d.scenario),template:redactConversationText(d.template),keywords:d.keywords.map(x=>redactConversationText(x)),objectionLogic:d.objectionLogic.map(x=>redactConversationText(x)),steps:d.steps.map(x=>redactConversationText(x)),boundaries:d.boundaries.map(x=>redactConversationText(x)),leadTypes:d.leadTypes.map(x=>redactConversationText(x))};
 return {...clean,id:`talk-${crypto.randomUUID()}`,title:talkTitle(saved.employeeName,clean.topic,1),employeeId:saved.employeeId,employeeName:saved.employeeName,departmentId:saved.departmentId,conversationSource:saved,dealId:'',status:'candidate' as const,version:1,weight:1,createdAt:now,updatedAt:now};});
 if((latest.talkTracks?.length??0)+tracks.length>500)throw new DomainError('话术库容量已满',413);
 (latest.talkTracks??=[]).unshift(...tracks);current.candidateIds=tracks.map(t=>t.id);current.status=tracks.length?'review':accepted.length?'duplicate':'screened_out';current.message=tracks.length?`${tracks.length}条对话案例话术待管理者审核；审核后用于本部门检索（词法检索，未建立向量索引）`:'没有新增可复用候选，原始脱敏案例已保留';current.updatedAt=now;delete current.leaseToken;delete current.leaseUntil;
 const expected=latest.revision;latest.revision++;try{await deps.save(expected,latest);return current;}catch(error){if(!conflict(error)||attempt===2)throw error;}}
 }catch{
 for(let attempt=0;attempt<3;attempt++){const latest=await deps.load();const current=latest.feedbackJobs?.find(j=>j.id===jobId);if(!current||current.leaseToken!==token)return current??job;const expected=latest.revision;latest.revision++;current.status='failed';current.message='提炼未完成，脱敏案例已保存；请检查模型配置后在原会话重试';delete current.leaseToken;delete current.leaseUntil;try{await deps.save(expected,latest);return current;}catch(error){if(!conflict(error)||attempt===2)throw error;}}
 }
 return (await deps.load()).feedbackJobs!.find(j=>j.id===jobId)!;
}
