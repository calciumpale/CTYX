import {knowledgeDepartmentForSalesId} from './knowledge-department-scope.ts';
import type {SalesScope} from './sales-scope.ts';
import {createWorkbenchKnowledgeAgent} from './knowledge-agent-runtime.ts';
import {prepareKnowledgeContext} from './knowledge-agent.ts';
import {extractProjectIntake} from './project-intake.ts';
import {processSalesIntelligence} from './sales-intelligence-service.ts';
import {persistSalesWorkspace, type GuardedWorkspaceWrite} from './sales-report-store.ts';
import { agentMemoryRuntime } from './agent-memory-runtime.ts';
import type { MemoryTranscript } from './agent-memory-types.ts';
import {salesMutationEvents} from './sales-report-domain.ts';
import type {SalesEvent} from './sales-report-types.ts';
import {createApprovalStore} from './approval-store.ts';
import {projectApprovalContext} from './approval-agent-context.ts';
import {reviewContract} from './contract-review.ts';
import { deduplicate,cosineSimilarity } from './talktrack-vectors.ts';
import { effectiveEmbedding } from './embedding-store.ts';
import { requestEmbeddings } from './embedding-client.ts';
import { createTalkIndex } from './talktrack-index.ts';
import { workbenchKnowledge } from './knowledge-library-runtime.ts';
import { runPlaybookFeedback } from './playbook-graph.ts';
import { feedbackBatches,maintainTalkTracks,talkText,talkTitle,transcriptHash } from './talktrack-domain.ts';
import type { TalkTrack } from './talktrack-types.ts';
import { env, waitUntil } from 'cloudflare:workers';
import { assertRevision, demoGenerate, DomainError, projectState } from './domain.ts';
import type { GenerationInput, GenerationOutput } from './domain.ts';
import { createSeed } from './seed.ts';
import { appendDepartmentStageExamples } from './workspace-departments-store.ts';
import { readEffectiveModel } from './connection-store.ts';
import { requestModelText } from './model-client.ts';
import { buildModelMessages } from './model-messages.ts';
import { readEffectiveCompanyConnection, readEffectiveJinghaiConnection } from './company-connection.ts';
import { researchCompany, searchCompanyExpansion } from './company-research.ts';
import { buildTrainingMessages, demoTrainingGenerate } from './training-dialogue.ts';
import type { TrainingGenerationInput } from './training-dialogue.ts';
import type { ApiResult, Role, WorkbenchState } from './types.ts';
import {executeMemberAction,requireMemberRole} from './member-policy.ts';
import type {MemberRole} from './member-types.ts';

const environment=()=>env as Cloudflare.Env;
function database():D1Database {
  const db=environment().DB;
  if(!db)throw new DomainError('体验空间数据库尚未连接，请配置D1绑定后再试',503);
  return db;
}
export function readRole(request:Request):Role {
  return requireMemberRole(request)==='sales'?'sales':'manager';
}
/** Trusted identity headers are injected/overwritten by the private Sites gateway. */
export function requireUserId(request:Request):string {
  requireMemberRole(request);
  const id=request.headers.get('oai-authenticated-user-id');
  if(!id||!request.headers.get('oai-authenticated-user-email'))throw new DomainError('请先使用平台账号登录',401);
  if(id.length>512)throw new DomainError('登录身份无效，请重新登录',401);
  return id;
}
async function applyModelStatus(state:WorkbenchState,userId:string,siteOrigin:string):Promise<void> {
  let model:Awaited<ReturnType<typeof readEffectiveModel>>=null;try{model=await readEffectiveModel(userId,siteOrigin);}catch{state.model={connected:false,name:'模型配置暂时不可用，请在设置中检查'};return;}
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = JSON.parse(row.state_json) as WorkbenchState;
    state.revision = row.revision;
    const current = await appendDepartmentStageExamples(db, userId, state, row.state_json);
    if (current) {
      await applyModelStatus(current, userId, siteOrigin);
      return current;
    }
    row = await db.prepare('SELECT state_json, revision FROM workbench_workspaces WHERE user_id = ?').bind(userId).first<{state_json:string;revision:number}>();
    if (!row) break;
  }
  throw new DomainError('工作空间已更新，请刷新后重试',409);
}
export async function saveWorkspace(userId:string,expectedRevision:number,state:WorkbenchState,events:SalesEvent[]=[],extra?:GuardedWorkspaceWrite):Promise<void> {
  await persistSalesWorkspace(database(),userId,expectedRevision,state,events,extra);
}
/** Derived analysis follows the committed business write and cannot roll it back. */
export async function refreshSalesProject(userId:string,dealId:string,siteOrigin:string,force=false):Promise<WorkbenchState>{
  let model:Awaited<ReturnType<typeof readEffectiveModel>>=null;
  try{model=await readEffectiveModel(userId,siteOrigin);}catch{/* Configuration failures must not discard saved customer facts. */}
  try{return await processSalesIntelligence(userId,dealId,siteOrigin,{load:loadWorkspace,save:saveWorkspace,model,generate:model?messages=>requestModelText(model!,messages,{timeoutMs:60000}):undefined},{force});}
  catch{return loadWorkspace(userId,siteOrigin);}
}

async function generate(input:GenerationInput,model:{key:string;url:string;name:string}|null):Promise<GenerationOutput> {
  if(!model){
    if(input.purpose==='chat')throw new DomainError('大模型当前不可用。请在设置的「服务连接」核对配置后重试。',503);
    return demoGenerate(input);
  }
  return {answer:await requestModelText(model,buildModelMessages(input)),mode:'live'};
}
async function generateTraining(input:TrainingGenerationInput,model:{key:string;url:string;name:string}|null):Promise<GenerationOutput> {
  if(!model)return demoTrainingGenerate(input);
  return {answer:await requestModelText(model,buildTrainingMessages(input)),mode:'live'};
}
export async function readSalesOwners(userId:string){const roster=await database().prepare("SELECT sales_id,display_name FROM workbench_member_accounts WHERE owner_id=? AND enabled=1 AND role='sales' AND sales_id IS NOT NULL").bind(userId).all<{sales_id:string;display_name:string}>();return roster.results.map(row=>({salesId:row.sales_id,displayName:row.display_name}));}
export async function readWorkbench(userId:string,role:Role,siteOrigin='https://production.invalid',salesScope?:SalesScope):Promise<WorkbenchState> {
  if(role==='sales'&&!salesScope)throw new DomainError('销售账号归属无效',401);return projectState(await loadWorkspace(userId,siteOrigin),role,salesScope);
}
/** Internal canonical result. The workbench route applies projectAccountResult exactly once. */
export async function mutateWorkbench(userId:string,role:Role,action:string,payload:Record<string,unknown>,revision:unknown,siteOrigin='https://production.invalid',memberRole:MemberRole=role,actorName?:string,salesScope?:SalesScope,memberId?:string):Promise<ApiResult> {
  if(role==='sales'&&!salesScope)throw new DomainError('销售账号归属无效',401);const state=await loadWorkspace(userId,siteOrigin);assertRevision(state,revision);
  const salesOwners=await readSalesOwners(userId);
  let model:Awaited<ReturnType<typeof readEffectiveModel>>=null;try{model=await readEffectiveModel(userId,siteOrigin);}catch{/* Keep customer writes usable when model settings need repair. */}
  let memory: ReturnType<typeof agentMemoryRuntime> | undefined;
  if (action === 'chat' && memberId && memberRole !== 'admin') {
    try {
      const runtime = agentMemoryRuntime(siteOrigin);
      await runtime.store.ready();
      memory = runtime;
    } catch { console.warn('Agent memory storage temporarily unavailable'); }
  }
  const memoryScope = (projectId = '') => ({ ownerId: userId, memberId: memberId!, projectId });
  const recallAgentMemory = memory && model ? (query: string, projectId?: string) =>
    memory.recall(memoryScope(projectId), query).catch(() => undefined) : undefined;
  const mutationAt=new Date().toISOString();
  const knowledgeAgent=createWorkbenchKnowledgeAgent(database(),userId,siteOrigin,{...(role==='sales'?{departmentId:knowledgeDepartmentForSalesId(salesScope?.salesId)}:{}),generate:model?(messages,options)=>requestModelText(model!,messages,{timeoutMs:options?.phase==='route'?8000:12000}):undefined});
  const managedByQuery = new Map<string, ReturnType<typeof workbenchKnowledge>>();
  const retrieveManagedKnowledge = (query: string) => {
    const cached = managedByQuery.get(query);
    if (cached) return cached;
    const lookup = workbenchKnowledge(database(), userId, siteOrigin, query);
    managedByQuery.set(query, lookup);
    return lookup;
  };
  const result=await executeMemberAction(state,memberRole,action,payload,{now:mutationAt,actorName,salesScope,salesOwners,retrieveManagedKnowledge,recallAgentMemory,searchCompanyExpansion,prepareKnowledge:(request,scope)=>scope?prepareKnowledgeContext({...request,intent:'business'},{retrieve:async()=>scope.knowledge.filter(item=>scope.knowledgeIds.includes(item.id))}):knowledgeAgent.prepare(request),extractIntake:model?text=>extractProjectIntake(text,messages=>requestModelText(model!,messages,{timeoutMs:60000})):undefined,contractModelName:model?.name,reviewContract:async(document,deal)=>{if(!model)throw new DomainError('请先在设置中配置并启用大模型 API，合同原文已保存',503);return reviewContract({...document,projectContext:JSON.stringify({projectName:deal.projectName??deal.name,company:deal.name,dataOrigin:deal.dataOrigin??'sample',userRecordedNeeds:deal.needs.slice(0,5).map(t=>t.slice(0,200)),userRecordedRisks:deal.risks.slice(0,5).map(t=>t.slice(0,200)),customerBudget:deal.customerProfile?.budget.slice(0,300),customerTimeline:deal.customerProfile?.timeline.slice(0,300)})},messages=>requestModelText(model,messages,{timeoutMs:60000}));},approveTalkTrack:async track=>{const embed=await effectiveEmbedding(userId);if(!embed)throw new DomainError('请在设置中配置并启用 Embedding API',503);const result=await requestEmbeddings(embed,[talkText(track)],{origin:siteOrigin});const index=createTalkIndex(database(),userId);const current=await index.all((state.talkTracks??[]).filter(t=>t.status==='candidate'||t.status==='published'),result.model);const activeIds=new Set((state.talkTracks??[]).filter(t=>t.status==='candidate'||t.status==='published').map(t=>t.id));if(current.some(v=>activeIds.has(v.id)&&v.id!==track.id&&v.model!==result.model))throw new DomainError('Embedding 模型已变更，请先重建索引',409);if(current.some(v=>v.id!==track.id&&v.model===result.model&&cosineSimilarity(v.vector,result.vectors[0])>=0.90))throw new DomainError('审核后的话术与现有条目高度相似，请调整或打回',409);const version=track.version+1;await index.upsert({...track,version,title:talkTitle(track.employeeName,track.topic,version)},result.vectors[0],result.model,'published');},retrieveTalkTracks:async query=>{const embed=await effectiveEmbedding(userId);if(!embed||!state.talkTracks?.some(t=>t.status==='published'))return [];const result=await requestEmbeddings(embed,[query],{origin:siteOrigin,timeoutMs:4500});return createTalkIndex(database(),userId).search(result.vectors[0],result.model,state.talkTracks);},generate:async input=>{if(input.deal&&['strategy','risk'].includes(input.agentId)){const page=await createApprovalStore(database()).list({id:userId,email:''},{scope:'mine',projectId:input.deal.id,limit:5});input.projectApprovals=await projectApprovalContext(page.records.map(item=>item.request),state,input.deal.id,userId);}return generate(input,model);},generateInsight:input=>generate(input,model),trainingGenerate:input=>generateTraining(input,model),enrichCompany:async deal=>{
    let qcc:Awaited<ReturnType<typeof readEffectiveCompanyConnection>>=null;
    let jinghai:Awaited<ReturnType<typeof readEffectiveJinghaiConnection>>=null;
    const issues:string[]=[];
    try{jinghai=await readEffectiveJinghaiConnection(userId);}catch{issues.push('鲸海数据配置暂时无法读取，请在服务连接中检查凭证。');}
    try{qcc=await readEffectiveCompanyConnection(userId);}catch{issues.push('企查查配置暂时无法读取，请在服务连接中检查凭证。');}
    const profile=await researchCompany(deal,{qcc,jinghai,model});
    profile.warnings.unshift(...issues);
    return profile;
  }});
  if(result.state.revision===state.revision)return {...result,state:await loadWorkspace(userId,siteOrigin)};
  const run = result.run;
  const transcript: MemoryTranscript | undefined = memory && run && !run.workflowId && run.status !== 'failed'
    ? { runId: run.id, query: run.query, answer: run.answer, createdAt: run.createdAt,
      trace: JSON.stringify({ agentIds: run.agentIds, steps: run.steps, citations: run.citations, mode: run.mode, duration: run.duration }) }
    : undefined;
  const scope = memoryScope(run?.dealId);
  await saveWorkspace(userId,state.revision,result.state,salesMutationEvents(state,result.state,action,payload,mutationAt),
    memory && transcript ? guard => memory.store.transcriptStatement(scope, transcript, guard) : undefined);
  if (memory && transcript && model) waitUntil(memory.capture(scope, transcript, model).catch(() => {
    // A transient provider failure leaves the original waiting for offline capture.
    console.warn('Agent memory capture deferred');
  }));
  const targetDealId=result.dealId||result.run?.dealId||(typeof payload.dealId==='string'?payload.dealId:'');
  const changedSalesData=['deal_create','deal_intake','deal_intake_followup','deal_note','deal_update','deal_enrich','deal_stage','deal_outcome','transcript_add','deal_assess'].includes(action)||(action==='chat'&&!!targetDealId&&result.state.deals.find(deal=>deal.id===targetDealId)?.version!==state.deals.find(deal=>deal.id===targetDealId)?.version);
  if(targetDealId&&changedSalesData){const next=await refreshSalesProject(userId,targetDealId,siteOrigin,action==='deal_assess');result.state=next;}
  if(['deal_outcome','transcript_add','feedback_retry'].includes(action)){await processFeedback(userId,String(payload.dealId),siteOrigin);return {...result,state:await loadWorkspace(userId,siteOrigin)};}
  return result;
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
    for(const candidate of generated.candidates){const source=sources.find(t=>t.id===candidate.draft.evidence[0].transcriptId)!;const track:TalkTrack={...candidate.draft,id:`talk-${crypto.randomUUID()}`,title:talkTitle(source.employeeName,candidate.draft.topic,1),employeeId:source.employeeId,employeeName:source.employeeName,departmentId:knowledgeDepartmentForSalesId(source.employeeId)??undefined,dealId,status:'candidate',version:1,weight:1,createdAt:now,updatedAt:now};await index.upsert(track,candidate.vector,candidate.model,'candidate');tracks.push(track);}
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
