import {reviewContract} from './contract-review.ts';
import { deduplicate,cosineSimilarity } from './talktrack-vectors.ts';
import { effectiveEmbedding } from './embedding-store.ts';
import { requestEmbeddings } from './embedding-client.ts';
import { createTalkIndex } from './talktrack-index.ts';
import { runPlaybookFeedback } from './playbook-graph.ts';
import { feedbackBatches,maintainTalkTracks,talkText,talkTitle,transcriptHash } from './talktrack-domain.ts';
import type { TalkTrack } from './talktrack-types.ts';
import { env } from 'cloudflare:workers';
import { assertRevision, demoGenerate, DomainError, executeAction, projectState } from './domain.ts';
import type { GenerationInput, GenerationOutput } from './domain.ts';
import { createSeed } from './seed.ts';
import { readEffectiveModel } from './connection-store.ts';
import { requestModelText } from './model-client.ts';
import { buildModelMessages } from './model-messages.ts';
import { readEffectiveCompanyConnection } from './company-connection.ts';
import { researchCompany } from './company-research.ts';
import { buildTrainingMessages, demoTrainingGenerate } from './training-dialogue.ts';
import type { TrainingGenerationInput } from './training-dialogue.ts';
import type { ApiResult, Role, WorkbenchState } from './types.ts';

export const ROLE_COOKIE='ctai_experience_role';
const environment=()=>env as Cloudflare.Env;
function database():D1Database {
  const db=environment().DB;
  if(!db)throw new DomainError('体验空间数据库尚未连接，请配置D1绑定后再试',503);
  return db;
}
export function readRole(request:Request):Role {
  const entry=(request.headers.get('cookie')??'').split(';').map(item=>item.trim()).find(item=>item.startsWith(`${ROLE_COOKIE}=`));
  return entry?.slice(ROLE_COOKIE.length+1)==='sales'?'sales':'manager';
}
export function roleCookie(role:Role,request:Request):string {
  return `${ROLE_COOKIE}=${role}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${new URL(request.url).protocol==='https:'?'; Secure':''}`;
}
/** Trusted identity headers are injected/overwritten by the private Sites gateway. */
export function requireUserId(request:Request):string {
  const id=request.headers.get('oai-authenticated-user-id');
  if(!id||!request.headers.get('oai-authenticated-user-email'))throw new DomainError('请先使用平台账号登录',401);
  if(id.length>512)throw new DomainError('登录身份无效，请重新登录',401);
  return id;
}
async function applyModelStatus(state:WorkbenchState,userId:string,siteOrigin:string):Promise<void> {
  const model=await readEffectiveModel(userId,siteOrigin);
  state.model={connected:!!model,name:model?`${model.name} · 已配置，生成时验证`:'规则演示 · 未连接外部模型'};
}
export async function loadWorkspace(userId:string,siteOrigin='https://production.invalid'):Promise<WorkbenchState> {
  const db=database();
  let row=await db.prepare('SELECT state_json, revision FROM workbench_workspaces WHERE user_id = ?').bind(userId).first<{state_json:string;revision:number}>();
  if(!row) {
    const now=new Date().toISOString();const seed=createSeed(now);
    await db.prepare('INSERT INTO workbench_workspaces (user_id, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING').bind(userId,JSON.stringify(seed),seed.revision,now,now).run();
    row=await db.prepare('SELECT state_json, revision FROM workbench_workspaces WHERE user_id = ?').bind(userId).first<{state_json:string;revision:number}>();
  }
  if(!row)throw new DomainError('体验空间初始化失败，请稍后重试',503);
  const state=JSON.parse(row.state_json) as WorkbenchState;
  state.revision=row.revision;await applyModelStatus(state,userId,siteOrigin);return state;
}
export async function saveWorkspace(userId:string,expectedRevision:number,state:WorkbenchState):Promise<void> {
  const json=JSON.stringify(state);if(new TextEncoder().encode(json).length>1800000)throw new DomainError('工作空间存储容量不足，请联系管理员扩容；本次新增内容未保存',413);
  const result=await database().prepare('UPDATE workbench_workspaces SET state_json = ?, revision = ?, updated_at = ? WHERE user_id = ? AND revision = ?').bind(json,state.revision,new Date().toISOString(),userId,expectedRevision).run();
  if(result.meta.changes!==1)throw new DomainError('工作空间已被另一请求更新，请刷新后重试；本次操作未保存',409);
}
async function generate(input:GenerationInput,model:{key:string;url:string;name:string}|null):Promise<GenerationOutput> {
  if(!model)return demoGenerate(input);
  return {answer:await requestModelText(model,buildModelMessages(input)),mode:'live'};
}
async function generateTraining(input:TrainingGenerationInput,model:{key:string;url:string;name:string}|null):Promise<GenerationOutput> {
  if(!model)return demoTrainingGenerate(input);
  return {answer:await requestModelText(model,buildTrainingMessages(input)),mode:'live'};
}
export async function readWorkbench(userId:string,role:Role,siteOrigin='https://production.invalid'):Promise<WorkbenchState> {
  return projectState(await loadWorkspace(userId,siteOrigin),role);
}
export async function mutateWorkbench(userId:string,role:Role,action:string,payload:Record<string,unknown>,revision:unknown,siteOrigin='https://production.invalid'):Promise<ApiResult> {
  const state=await loadWorkspace(userId,siteOrigin);assertRevision(state,revision);
  const model=await readEffectiveModel(userId,siteOrigin);
  const result=await executeAction(state,role,action,payload,{contractModelName:model?.name,reviewContract:async(document,deal)=>{if(!model)throw new DomainError('请先在设置中配置并启用大模型 API，合同原文已保存',503);return reviewContract({...document,projectContext:JSON.stringify({projectName:deal.projectName??deal.name,company:deal.name,dataOrigin:deal.dataOrigin??'sample',userRecordedNeeds:deal.needs.slice(0,5).map(t=>t.slice(0,200)),userRecordedRisks:deal.risks.slice(0,5).map(t=>t.slice(0,200)),customerBudget:deal.customerProfile?.budget.slice(0,300),customerTimeline:deal.customerProfile?.timeline.slice(0,300)})},messages=>requestModelText(model,messages,{timeoutMs:60000}));},approveTalkTrack:async track=>{const embed=await effectiveEmbedding(userId);if(!embed)throw new DomainError('请在设置中配置并启用 Embedding API',503);const result=await requestEmbeddings(embed,[talkText(track)],{origin:siteOrigin});const index=createTalkIndex(database(),userId);const current=await index.all((state.talkTracks??[]).filter(t=>t.status==='candidate'||t.status==='published'),result.model);const activeIds=new Set((state.talkTracks??[]).filter(t=>t.status==='candidate'||t.status==='published').map(t=>t.id));if(current.some(v=>activeIds.has(v.id)&&v.id!==track.id&&v.model!==result.model))throw new DomainError('Embedding 模型已变更，请先重建索引',409);if(current.some(v=>v.id!==track.id&&v.model===result.model&&cosineSimilarity(v.vector,result.vectors[0])>=0.90))throw new DomainError('审核后的话术与现有条目高度相似，请调整或打回',409);const version=track.version+1;await index.upsert({...track,version,title:talkTitle(track.employeeName,track.topic,version)},result.vectors[0],result.model,'published');},retrieveTalkTracks:async query=>{const embed=await effectiveEmbedding(userId);if(!embed||!state.talkTracks?.some(t=>t.status==='published'))return [];const result=await requestEmbeddings(embed,[query],{origin:siteOrigin});return createTalkIndex(database(),userId).search(result.vectors[0],result.model,state.talkTracks);},generate:input=>generate(input,model),trainingGenerate:input=>generateTraining(input,model),enrichCompany:async deal=>{
    let qcc:Awaited<ReturnType<typeof readEffectiveCompanyConnection>>=null;let configurationIssue=false;
    try{qcc=await readEffectiveCompanyConnection(userId);}catch{configurationIssue=true;}
    const profile=await researchCompany(deal,{qcc,model});
    if(configurationIssue)profile.warnings.unshift('企查查配置暂时无法使用，已改用公开网络检索；请在设置中重新保存凭证。');
    return profile;
  }});
  await saveWorkspace(userId,state.revision,result.state);
  if(['deal_outcome','transcript_add','feedback_retry'].includes(action)){await processFeedback(userId,String(payload.dealId),siteOrigin);return {...result,state:await readWorkbench(userId,role,siteOrigin)};}
  return {...result,state:projectState(result.state,role)};
}

/** Persist outcome/source first, then claim a bounded job. Never roll back a saved sale on provider failure. */
export async function processFeedback(userId:string,dealId:string,origin:string):Promise<void>{
  let leaseToken:string|undefined;let jobId:string|undefined;
  try{
    const state=await loadWorkspace(userId,origin);const job=state.feedbackJobs?.find(j=>j.dealId===dealId&&(['queued','waiting_config','failed'].includes(j.status)||j.status==='running'&&Date.parse(j.leaseUntil??'')<Date.now()));
    const deal=state.deals.find(d=>d.id===dealId);if(!job||!deal||deal.outcome!=='won'||deal.dataOrigin!=='manual')return;jobId=job.id;
    const [model,embedding]=await Promise.all([readEffectiveModel(userId,origin),effectiveEmbedding(userId)]);
    const revision=state.revision;state.revision++;job.updatedAt=new Date().toISOString();
    if(!model||!embedding){job.status='waiting_config';job.message=`请先在设置中配置并启用${!model?'大模型 API':''}${!model&&!embedding?'和':''}${!embedding?'Embedding API':''}，然后重试`;await saveWorkspace(userId,revision,state);return;}
    job.status='running';job.message='正在筛选原文、提炼模板并进行向量去重';leaseToken=crypto.randomUUID();job.leaseToken=leaseToken;job.leaseUntil=new Date(Date.now()+15*60000).toISOString();await saveWorkspace(userId,revision,state);
    const sources=(state.transcripts??[]).filter(t=>t.dealId===dealId);const index=createTalkIndex(database(),userId);const active=new Set((state.talkTracks??[]).filter(t=>['candidate','published'].includes(t.status)).map(t=>t.id));const existing=(await index.all((state.talkTracks??[]).filter(t=>active.has(t.id)),`${embedding.url}#${embedding.name}`));
    const modelIdentity=`${embedding.url}#${embedding.name}`;if(existing.some(v=>v.model!==modelIdentity))throw new DomainError('Embedding 模型已变更，请在设置中重建话术索引后重试',409);
    const generated:Awaited<ReturnType<typeof runPlaybookFeedback>>={candidates:[],duplicates:[],screenedOut:0,steps:[]};
    // Attribution follows original transcripts, never the manager initiating the action.
    const batches=feedbackBatches(sources);
    for(const batch of batches){const output=await runPlaybookFeedback({transcripts:batch,existing:[...existing,...generated.candidates.map((c,i)=>({id:`batch-${i}`,title:c.draft.topic,vector:c.vector,model:c.model}))]},{generate:messages=>requestModelText(model,messages),embed:texts=>requestEmbeddings(embedding,texts,{origin})});generated.candidates.push(...output.candidates);generated.duplicates.push(...output.duplicates);generated.screenedOut+=output.screenedOut;generated.steps.push(...output.steps);}
    const latest=await loadWorkspace(userId,origin);const current=latest.feedbackJobs?.find(j=>j.id===jobId);const latestDeal=latest.deals.find(d=>d.id===dealId);if(!current||current.leaseToken!==leaseToken||latestDeal?.outcome!=='won'||await transcriptHash(latestDeal,(latest.transcripts??[]).filter(t=>t.dealId===dealId))!==current.sourceHash)return;
    const finalActive=new Set((latest.talkTracks??[]).filter(t=>['candidate','published'].includes(t.status)).map(t=>t.id));const finalExisting=await index.all((latest.talkTracks??[]).filter(t=>finalActive.has(t.id)),modelIdentity);const finalDedup=deduplicate(generated.candidates.map(c=>({...c,title:c.draft.topic})),finalExisting);generated.candidates=finalDedup.accepted;generated.duplicates.push(...finalDedup.duplicates);
    const now=new Date().toISOString();const tracks:TalkTrack[]=[];
    if((latest.talkTracks?.length??0)+generated.candidates.length>500)throw new DomainError('话术库达到内置容量，请扩容后重试',503);
    for(const candidate of generated.candidates){const source=sources.find(t=>t.id===candidate.draft.evidence[0].transcriptId)!;const track:TalkTrack={...candidate.draft,id:`talk-${crypto.randomUUID()}`,title:talkTitle(source.employeeName,candidate.draft.topic,1),employeeId:source.employeeId,employeeName:source.employeeName,dealId,status:'candidate',version:1,weight:1,createdAt:now,updatedAt:now};await index.upsert(track,candidate.vector,candidate.model,'candidate');tracks.push(track);}
    (latest.talkTracks??=[]).unshift(...tracks);current.candidateIds=tracks.map(t=>t.id);current.status=tracks.length?'review':generated.duplicates.length?'duplicate':'screened_out';current.message=tracks.length?`${tracks.length}条候选等待管理者审核；${generated.duplicates.length}条重复已过滤` : generated.duplicates.length?'提炼内容与已有话术相似，已自动去重':'未找到证据充分且可复用的片段，本次未生成候选';current.updatedAt=now;delete current.leaseToken;delete current.leaseUntil;const expected=latest.revision;latest.revision++;await saveWorkspace(userId,expected,latest);
  }catch(error){
    // Safe diagnostic strings only; provider bodies/credentials never enter workspace history.
    for(let retry=0;retry<3;retry++){try{const state=await loadWorkspace(userId,origin);const job=state.feedbackJobs?.find(j=>j.id===jobId);if(!job||(leaseToken&&job.leaseToken!==leaseToken))return;const revision=state.revision;state.revision++;job.status='failed';job.message=error instanceof DomainError?error.message:'提炼或向量去重未完成，请核对服务配置后重试；原转写已保存';job.updatedAt=new Date().toISOString();delete job.leaseToken;delete job.leaseUntil;await saveWorkspace(userId,revision,state);return;}catch{if(retry===2)return;}}
  }
}
export async function rebuildTalkIndex(userId:string,origin:string):Promise<void>{
  const embedding=await effectiveEmbedding(userId);if(!embedding)throw new DomainError('请先保存并启用向量服务配置');const state=await loadWorkspace(userId,origin);const tracks=(state.talkTracks??[]).filter(t=>['candidate','published'].includes(t.status));if(tracks.length>500)throw new DomainError('内置容量已满，请先扩容',503);const index=createTalkIndex(database(),userId);
  for(let at=0;at<tracks.length;at+=20){const batch=tracks.slice(at,at+20);const result=await requestEmbeddings(embedding,batch.map(talkText),{origin});for(let i=0;i<batch.length;i++)await index.upsert(batch[i],result.vectors[i],result.model);}
}
/** Owner-private gateway is the service boundary. No arbitrary user ID or text accepted. */
export async function runTalkMaintenance(origin:string,userId?:string):Promise<{workspaces:number;updated:number}>{
  const ids=userId?[userId]:(await database().prepare('SELECT user_id FROM workbench_workspaces').all<{user_id:string}>()).results.map(r=>r.user_id);let updated=0,workspaces=0;
  for(const id of ids){for(let retry=0;retry<3;retry++){const state=await loadWorkspace(id,origin);if(!state.talkTrackPolicy?.enabled)break;const revision=state.revision;const count=maintainTalkTracks(state,new Date().toISOString());state.revision++;try{await saveWorkspace(id,revision,state);updated+=count;workspaces++;break;}catch(e){if(!(e instanceof DomainError)||e.status!==409||retry===2)throw e;}}}
  return {workspaces,updated};
}
