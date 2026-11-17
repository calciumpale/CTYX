import { RECORDING_INBOX_DEAL_ID } from './recording-inbox-types.ts';
import {canReadLegacyKnowledge} from './knowledge-content-scope.ts';
import {knowledgeDepartmentForSalesId} from './knowledge-department-scope.ts';
import { markSalesBusinessChanges } from './sales-project-eligibility.ts';
import {bindScope,scopeFor,rosterFor} from './sales-scope.ts';
import type {SalesScope,SalesOwner} from './sales-scope.ts';
import type {KnowledgeAgentRequest,KnowledgePreparedContext,KnowledgeAgentEvidence} from './knowledge-agent.ts';
import {validateIntakeExtraction} from './project-intake.ts';
import type {IntakeExtraction} from './project-intake-types.ts';
import type {ProjectApprovalContext} from './approval-agent-context.ts';
import { handleContractAction } from './contract-domain.ts';
import type { ContractAnalysis,ContractDocument } from './contract-types.ts';
import { approvedTracks, handleTalkAction, talkKnowledge } from './talktrack-domain.ts';
import type { TalkTrack } from './talktrack-types.ts';
import { AGENTS, STAGES } from './types.ts';
import type { AgentId, ApiResult, CompanyProfile, CustomerProfile, Deal, FlowNode, FollowupRecording, Knowledge, PublishedWorkflow, Role, Run, Skill, TraceStep, TrainingSession, WorkbenchState, Workflow } from './types.ts';
import { defaultTrainingProfile, validateTrainingProfile } from './training-profile.ts';
import { demoTrainingGenerate, type TrainingGenerationOutput } from './training-dialogue.ts';
import type { TrainingGenerationInput } from './training-dialogue.ts';
import { evaluateTraining, type TrainingEvaluator } from './training-evaluation.ts';
import type { AgentMemoryContext } from './agent-memory-types.ts';
import { CUSTOMER_DEMAND_INSTRUCTION, CUSTOMER_INSIGHT_INSTRUCTION, CUSTOMER_RECORD_INSTRUCTION, customerDemandEvidence, customerInsightEvidence, formatCustomerDemand, formatCustomerEvidenceQuote, formatCustomerInsightResult, formatCustomerRecordResult, isCustomerDemandFollowup, isCustomerDemandQuestion, isCustomerInsightQuestion, isCustomerProfileRefreshRequest, isCustomerProfileRequest, isCustomerRecordFollowup, isCustomerRecordQuestion, supportsDemand, type CustomerInsightEvidence } from './customer-insight.ts';
import { isPropertyQuestion, parsePropertyPageRequest } from './property-query.ts';
import { isCompletedChatRun } from './chat-request.ts';
import { companyRecordEvidencePassage, type searchCompanyRecords } from './company-record-research.ts';
import type { searchJinghaiCompanyPenalties } from './jinghai-record-research.ts';
import type { ChatProgressStep } from './chat-progress.ts';
import type { RecordingProcessingApply } from './recording-processing-types.ts';
import { buildChatPortfolio, isPortfolioCount, isPortfolioCountQuestion, isWholePortfolioQuery, portfolioCountFallback, verifiedPortfolioCount, type ChatPortfolio } from './chat-portfolio.ts';

export type { ChatProgressStep } from './chat-progress.ts';

export class DomainError extends Error {
  status:number;
  constructor(message:string,status=400) { super(message); this.name='DomainError'; this.status=status; }
}
/** Internal visibility metadata stays in D1 and is stripped from API projections. */
interface WorkflowFrame {knowledgeIds:string[];answerIds:string[];targets?:string[];knowledgeRoute?:KnowledgePreparedContext['route'];}
interface WorkflowCheckpoint {workflow:Workflow;role:Role;deal?:Deal;deals:Deal[];knowledge:Record<string,Knowledge>;answers:Record<string,string>;frames:Record<string,WorkflowFrame>;order:string[];cursor:number;}
type StoredState=WorkbenchState & {_access?:Record<string,string>;_workflowRuns?:Record<string,WorkflowCheckpoint>};
type GenerationKnowledge=Knowledge & {applicability?:string[]};
export interface GenerationInput {salesScope?:SalesScope;query:string;agentId:AgentId;projectApprovals?:ProjectApprovalContext[];deal?:Deal;deals:Deal[];portfolio?:ChatPortfolio;knowledge:GenerationKnowledge[];instruction?:string;previous?:string;history?:{query:string;answer:string}[];contractReviews?:{title:string;reviewedAt?:string;analysis:ContractAnalysis}[];purpose?:'chat'|'workflow';customerInsightEvidence?:CustomerInsightEvidence[];publicCompanyEvidence?:CustomerInsightEvidence[];agentMemory?:AgentMemoryContext;}
export interface GenerationOutput {answer:string;mode:'demo'|'live';modelName?:string;groundingRejected?:boolean;evidenceIds?:string[];}
export interface ActionContext {trustedRecordingProcessing?:RecordingProcessingApply;onChatProgress?:(step:ChatProgressStep)=>void;requireNarrative?:boolean;searchCompanyExpansion?:(company:Pick<Deal,'name'>)=>Promise<CompanyProfile>;searchCompanyRecords?:typeof searchCompanyRecords;searchCompanyPenalties?:(company:Pick<Deal,'name'>,query:string)=>Promise<Awaited<ReturnType<typeof searchJinghaiCompanyPenalties>>|undefined>;salesScope?:SalesScope;salesOwners?:SalesOwner[];prepareKnowledge?:(request:KnowledgeAgentRequest,scope?:{knowledgeIds:string[];knowledge:Knowledge[]})=>Promise<KnowledgePreparedContext>;actorName?:string;extractIntake?:(text:string)=>Promise<IntakeExtraction>;now?:string;generate?:(input:GenerationInput)=>Promise<GenerationOutput>;generateInsight?:(input:GenerationInput)=>Promise<GenerationOutput>;trainingGenerate?:(input:TrainingGenerationInput)=>Promise<TrainingGenerationOutput>;trainingEvaluate?:TrainingEvaluator;enrichCompany?:(deal:Deal)=>Promise<CompanyProfile>;trustedRecording?:FollowupRecording;reviewContract?:(document:ContractDocument,deal:Deal)=>Promise<ContractAnalysis>;contractModelName?:string;approveTalkTrack?:(track:TalkTrack)=>Promise<void>;retrieveTalkTracks?:(query:string)=>Promise<TalkTrack[]>;retrieveManagedKnowledge?:(query:string)=>Promise<Knowledge[]>;recallAgentMemory?:(query:string,projectId?:string)=>Promise<AgentMemoryContext|undefined>;}
const agentIds=new Set(AGENTS.map(item=>item.id));
const nodeTypes=new Set(['start','intent','knowledge','agent','review','output']);
const managerActions=new Set(['skill_review','knowledge_add','workflow_save','workflow_publish','workflow_review']);
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID()}`;
function fail(message:string,status=400):never { throw new DomainError(message,status); }
function text(value:unknown,label:string,max=4000):string {
  if(typeof value!=='string'||!value.trim()) fail(`请填写${label}`);
  if(value.length>max) fail(`${label}不能超过${max}字`);
  return value.trim();
}
function optional(value:unknown,max=4000):string {
  if(value===undefined||value===null||value==='') return '';
  if(typeof value!=='string'||value.length>max) fail('文本格式或长度不正确');
  return value.trim();
}
const projectFields=new Set(['projectName','name','contact','position','industry','stage','amount','priority','nextAction','summary','needs','source','website','region','customerProfile','deadline','cardColor']);
const profileFields=['decisionChain','goals','concerns','budget','timeline'] as const;
function object(value:unknown):Record<string,unknown>|undefined {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}
function onlyFields(value:Record<string,unknown>,allowed:Set<string>) {
  if(Object.keys(value).some(key=>!allowed.has(key)))fail('项目参数包含不允许修改的字段');
}
/** A saved public reference must not point back into a local or credentialed URL. */
function publicUrl(value:unknown):string {
  const raw=text(value,'公开网址',2000);let url:URL;
  try {url=new URL(raw);}catch {fail('请填写有效的公开 HTTP 或 HTTPS 网址');}
  const host=url.hostname.toLowerCase().replace(/\.$/,'');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!host.includes('.')||host.endsWith('.local')||host.endsWith('.localhost')||host.endsWith('.internal')||host.startsWith('['))fail('请填写有效的公开 HTTP 或 HTTPS 网址');
  if(/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a,b]=host.split('.').map(Number);
    if(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19))fail('请填写可公开访问的网址');
  }
  return url.toString();
}
function customerProfile(value:unknown,previous?:CustomerProfile):CustomerProfile {
  const input=object(value);if(!input)fail('客户画像格式不正确');
  onlyFields(input,new Set(profileFields));
  return Object.fromEntries(profileFields.map(key=>[key,Object.hasOwn(input,key)?optional(input[key],2000):previous?.[key]??''])) as unknown as CustomerProfile;
}
function projectChanges(payload:Record<string,unknown>,previous?:Deal):Partial<Deal> {
  const changes:Partial<Deal>={};
  for(const key of ['projectName','name'] as const)if(Object.hasOwn(payload,key))changes[key]=text(payload[key],key==='name'?'企业名称':'项目名称',200);
  for(const [key,max] of [['contact',120],['position',120],['industry',100],['nextAction',2000],['summary',5000],['source',300],['region',120]] as const)if(Object.hasOwn(payload,key))changes[key]=optional(payload[key],max);
  if(Object.hasOwn(payload,'stage')) {if(!STAGES.includes(payload.stage as typeof STAGES[number]))fail('商机阶段不正确');changes.stage=payload.stage as string;}
  if(Object.hasOwn(payload,'priority')) {if(!['high','medium','low'].includes(payload.priority as string))fail('优先级不正确');changes.priority=payload.priority as Deal['priority'];}
  if(Object.hasOwn(payload,'amount')) {if(typeof payload.amount!=='number'||!Number.isFinite(payload.amount)||payload.amount<0||payload.amount>1e12)fail('项目金额须为0至1万亿元之间的有效数字');changes.amount=payload.amount;}
  if(Object.hasOwn(payload,'website')) {const website=optional(payload.website,2000);changes.website=website?publicUrl(website):'';}
  if(Object.hasOwn(payload,'deadline')){const value=optional(payload.deadline,40);if(value&&(!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))))fail('截止时间须包含时区');changes.deadline=value?new Date(value).toISOString():'';}
  if(Object.hasOwn(payload,'cardColor')){const value=optional(payload.cardColor,7);if(value&&!/^#[0-9a-f]{6}$/i.test(value))fail('卡片颜色须为六位十六进制颜色');changes.cardColor=value;}
  if(Object.hasOwn(payload,'needs'))changes.needs=list(payload.needs,[]);
  if(Object.hasOwn(payload,'customerProfile'))changes.customerProfile=customerProfile(payload.customerProfile,previous?.customerProfile);
  return changes;
}
function assignedOwner(state:WorkbenchState,role:Role,requested:unknown,actorName?:string):{ownerId:string;owner:string} {
  if(role==='sales') {if(requested!==undefined)fail('销售只能创建自己负责的项目');return {ownerId:scopeFor(state).salesId,owner:actorName??scopeFor(state).displayName};}
  if(requested===undefined||requested==='manager')return {ownerId:'manager',owner:actorName??'周予安'};
  const id=text(requested,'负责人',100);const roster=rosterFor(state);const existing=roster?roster.find(item=>item.salesId===id):state.deals.find(deal=>deal.ownerId===id);
  if(roster){if(!existing)fail('请选择启用的销售负责人');const member=existing as SalesOwner;return {ownerId:member.salesId,owner:member.displayName};}
  if(!existing)fail('请选择已有的项目负责人');
  return {ownerId:(existing as Deal).ownerId,owner:(existing as Deal).owner};
}
function profileTime(value:unknown):string {
  const date=text(value,'来源获取时间',40);if(!Number.isFinite(Date.parse(date)))fail('来源获取时间不正确');return date;
}
/** Validate again at the trusted service boundary; client payloads cannot create research facts. */
export function validateCompanyProfile(value:unknown,deal:Deal):CompanyProfile {
  try {
    const input=object(value);if(!input)fail('企业画像格式不正确');
    const companyName=text(input.companyName,'企业名称',200);if(companyName!==deal.name.trim())fail('企业画像与当前企业不匹配');
    if(input.provider!=='qcc'&&input.provider!=='jinghai'&&input.provider!=='web')fail('企业画像来源不正确');
    if(input.status!=='ready'&&input.status!=='partial')fail('企业画像状态不正确');
    if(typeof input.modelUsed!=='boolean')fail('企业画像生成方式不正确');
    if(!Array.isArray(input.sources)||input.sources.length>20||!Array.isArray(input.facts)||input.facts.length>30)fail('企业画像资料数量超出限制');
    const provider:CompanyProfile['provider']=input.provider;const sourceIds=new Set<string>();
    const sources:CompanyProfile['sources']=input.sources.map(value=> {
      const source=object(value);if(!source)fail('企业画像来源格式不正确');
      const id=text(source.id,'来源标识',100);if(sourceIds.has(id)||source.provider!==provider)fail('企业画像来源标识或类型不正确');sourceIds.add(id);
      return {id,title:text(source.title,'来源标题',300),url:publicUrl(source.url),provider,retrievedAt:profileTime(source.retrievedAt),...(source.snippet!==undefined?{snippet:optional(source.snippet,2000)}:{})};
    });
    const facts=input.facts.map(value=> {
      const fact=object(value);if(!fact||!Array.isArray(fact.sourceIds)||!fact.sourceIds.length||fact.sourceIds.length>20||fact.sourceIds.some(id=>typeof id!=='string'||!sourceIds.has(id)))fail('企业事实缺少有效来源');
      return {label:text(fact.label,'企业事实名称',120),value:text(fact.value,'企业事实',3000),sourceIds:[...new Set(fact.sourceIds as string[])]};
    });
    if(input.status==='ready'&&!sources.length)fail('完整企业画像须包含可核验来源');
    const summary=optional(input.summary,12000);if(!summary&&!facts.length)fail('企业画像没有可展示内容');
    return {companyName,summary,facts,sources,provider,status:input.status,warnings:list(input.warnings,[],10),updatedAt:profileTime(input.updatedAt),modelUsed:input.modelUsed};
  }catch {throw new DomainError('企业补全结果缺少有效来源或格式异常，本次未保存',502);}
}
async function enrichDeal(deal:Deal,context:ActionContext):Promise<CompanyProfile> {
  if(!context.enrichCompany)fail('企业检索服务暂时不可用，请稍后重试',503);
  return validateCompanyProfile(await context.enrichCompany(structuredClone(deal)),deal);
}
function companyCitations(deal:Deal,profile=deal.companyProfile):Run['citations'] {
  return profile?.sources.map(source=>({id:`company-${deal.id}-${source.id}`,title:source.title,excerpt:`${source.url}\n来源：${source.provider==='qcc'?'企查查':source.provider==='jinghai'?'鲸海数据':'公开网络'}；获取时间：${source.retrievedAt}`}))??[];
}
function companyAnswer(profile:CompanyProfile):string {
  return [`## ${profile.companyName} · 企业画像`,profile.summary,...(profile.facts.length?['### 已检索资料',...profile.facts.map(fact=>`- **${fact.label}**：${fact.value}`)]:[]),...(profile.warnings.length?['### 待核实事项',...profile.warnings.map(item=>`- ${item}`)]:[]),...(profile.sources.length?['### 来源',...profile.sources.map(source=>`- [${source.title}](${source.url})`)]:[])].join('\n\n');
}
function list(value:unknown,fallback:string[],max=20):string[] {
  if(value===undefined) return fallback;
  if(!Array.isArray(value)||value.length>max) fail(`列表最多${max}项`);
  return value.map(item=>text(item,'列表项',2000));
}
function find<T extends {id:string}>(items:T[],id:unknown,label:string):T {
  const item=items.find(item=>item.id===id); if(!item) fail(`${label}不存在或已被删除`,404); return item;
}
function visibleDeal(state:WorkbenchState,role:Role,id:unknown):Deal {
  const deal=find(state.deals,id,'客户');
  if(role==='sales'&&deal.ownerId!==scopeFor(state).salesId) fail('当前销售视角无权访问该项目',403);
  return deal;
}
function checkVersion(actual:number,supplied:unknown) {if(!Number.isInteger(supplied)||actual!==supplied) fail('记录已更新，请刷新后重试',409);}
function ownerOf(state:StoredState,id:string):string {return state._access?.[id]??'manager';}
function owned(state:StoredState,id:string,role:Role) {
  if(role==='sales'&&ownerOf(state,id)!==scopeFor(state).salesId) fail('当前视角无权访问这条记录',403);
}
function mark(state:StoredState,id:string,role:Role) { (state._access??={})[id]=role==='sales'?scopeFor(state).salesId:'manager'; }
function activity(state:StoredState,role:Role,title:string,detail:string,type:string,now:string) {
  const entry={id:uid('activity'),title,detail,date:now,type};state.activities.unshift(entry);mark(state,entry.id,role);state.activities=state.activities.slice(0,150);
}
export function assertRevision(state:WorkbenchState,revision:unknown) {
  if(!Number.isInteger(revision)||revision!==state.revision) fail('工作空间已更新，请刷新后重试；本次操作未保存',409);
}
export function projectState(state:WorkbenchState,role:Role,scope?:SalesScope):WorkbenchState {
  const result=structuredClone(state) as StoredState;bindScope(result,scope??scopeFor(state));
  if(role==='sales') {
    const ownIds=new Set(result.deals.filter(d=>d.ownerId===scopeFor(result).salesId).map(d=>d.id));
    result.contracts=result.contracts?.filter(c=>ownIds.has(c.dealId));
    result.transcripts=result.transcripts?.filter(t=>ownIds.has(t.dealId));
    result.feedbackJobs=result.feedbackJobs?.filter(j=>ownIds.has(j.dealId)||j.conversationSource?.employeeId===scopeFor(result).salesId);
    result.talkTracks=result.talkTracks?.filter(t=>(t.status==='published'&&canReadLegacyKnowledge(t,result._access??{},knowledgeDepartmentForSalesId(scopeFor(result).salesId)))||ownIds.has(t.dealId)||t.conversationSource?.employeeId===scopeFor(result).salesId);
    result.talkTrackUsages=result.talkTrackUsages?.filter(u=>!u.dealId||ownIds.has(u.dealId));
    result.deals=result.deals.filter(item=>item.ownerId===scopeFor(result).salesId);
    result.workflows=result.workflows.filter(item=>item.published||item.status==='published').map(publishedView);
    result.skills=result.skills.filter(item=>item.status==='published'||ownerOf(result,item.id)===scopeFor(result).salesId||(scopeFor(result).salesId==='sales-1'&&!result._access?.[item.id]&&item.author==='林晓'));
    result.knowledge=result.knowledge.filter(item=>item.status==='published');
    result.runs=result.runs.filter(item=>ownerOf(result,item.id)===scopeFor(result).salesId);
    result.trainingSessions=result.trainingSessions.filter(item=>ownerOf(result,item.id)===scopeFor(result).salesId);
    result.activities=result.activities.filter(item=>ownerOf(result,item.id)===scopeFor(result).salesId||scopeFor(result).salesId==='sales-1'&&item.id==='activity-1');
  }
  for(const job of result.feedbackJobs??[]){delete job.leaseToken;delete job.leaseUntil;}
  result.role=role;
  result.viewer={name:role==='sales'?scopeFor(result).displayName:'周予安',team:'销售工作空间',salesId:scopeFor(result).salesId};
  delete result._access;
  delete result._workflowRuns;
  return result;
}

/** Drafts may be incomplete; no draft can contain arbitrary node types or bad references. */
export function validateWorkflow(workflow:Workflow,complete=false):string[] {
  if(!workflow||typeof workflow!=='object'||!Array.isArray(workflow.nodes)||!Array.isArray(workflow.edges)) fail('工作流格式不正确');
  if(workflow.nodes.length>30||workflow.edges.length>80) fail('工作流最多30个节点、80条连接');
  const nodeMap=new Map<string,FlowNode>();
  for(const node of workflow.nodes) {
    if(!node||typeof node!=='object') fail('节点格式不正确');
    text(node.id,'节点编号',100);text(node.label,'节点名称',120);
    if(['__proto__','constructor','prototype'].includes(node.id))fail('节点编号使用了保留名称，请更换编号');
    if(!nodeTypes.has(node.type)) fail('只允许开始、意图、知识、专家、人工审核和输出节点');
    if(nodeMap.has(node.id)) fail('节点编号不能重复');
    if(!Number.isFinite(node.x)||!Number.isFinite(node.y)) fail('节点位置必须为有效数值');
    if(node.agentId!==undefined&&!agentIds.has(node.agentId)) fail('请选择五位领域专家之一');
    if(complete&&node.type==='agent'&&!node.agentId) fail(`请为“${node.label}”选择专家`);
    optional(node.instruction,3000);nodeMap.set(node.id,node);
    if(node.knowledgeIds!==undefined&&(!Array.isArray(node.knowledgeIds)||node.knowledgeIds.length>40||node.knowledgeIds.some(id=>typeof id!=='string'||!id.trim()||id.length>100)))fail('知识选择格式不正确，最多选择40条生效资料');
  }
  const edgeKeys=new Set<string>();
  for(const edge of workflow.edges) {
    if(!edge||typeof edge!=='object'||!nodeMap.has(edge.from)||!nodeMap.has(edge.to)) fail('连接引用了不存在的节点');
    const key=`${edge.from}\0${edge.to}`;if(edgeKeys.has(key)) fail('连接不能重复');edgeKeys.add(key);
    if(edge.condition!==undefined&&(!agentIds.has(edge.condition as AgentId)&&edge.condition!=='default'))fail('意图分支条件不正确');
    if(edge.condition!==undefined&&nodeMap.get(edge.from)!.type!=='intent')fail('只有意图识别节点可以配置分支条件');
  }
  for(const node of workflow.nodes.filter(node=>node.type==='intent')) {
    const outgoing=workflow.edges.filter(edge=>edge.from===node.id);
    if(!outgoing.some(edge=>edge.condition!==undefined))continue;
    if(outgoing.some(edge=>edge.condition===undefined))fail('意图分支需为每条连线选择条件');
    const conditions=outgoing.map(edge=>edge.condition);
    if(new Set(conditions).size!==conditions.length)fail('同一个意图节点的分支条件不能重复');
    if(complete&&!conditions.includes('default'))fail('意图分支必须有且只有一条默认路径');
  }
  const indegree=new Map(workflow.nodes.map(node=>[node.id,0]));
  for(const edge of workflow.edges) indegree.set(edge.to,indegree.get(edge.to)!+1);
  const queue=workflow.nodes.filter(node=>indegree.get(node.id)===0).map(node=>node.id);const order:string[]=[];
  while(queue.length) {const id=queue.shift()!;order.push(id);for(const edge of workflow.edges.filter(edge=>edge.from===id)) {indegree.set(edge.to,indegree.get(edge.to)!-1);if(indegree.get(edge.to)===0)queue.push(edge.to);}}
  if(complete) {
    if(order.length!==workflow.nodes.length) fail('工作流包含循环，请移除回连');
    const starts=workflow.nodes.filter(node=>node.type==='start');const outputs=workflow.nodes.filter(node=>node.type==='output');
    if(starts.length!==1) fail('发布或测试需要且只允许一个开始节点');
    if(!outputs.length) fail('工作流需要至少一个输出节点');
    if(workflow.edges.some(edge=>edge.to===starts[0].id)) fail('开始节点不能有输入连接');
    if(outputs.some(node=>workflow.edges.some(edge=>edge.from===node.id))) fail('输出节点不能连接后续节点');
    const reachable=new Set<string>();const visit=(id:string)=>{if(reachable.has(id))return;reachable.add(id);workflow.edges.filter(edge=>edge.from===id).forEach(edge=>visit(edge.to));};visit(starts[0].id);
    if(reachable.size!==workflow.nodes.length) fail('所有节点都必须能从开始节点到达');
    const reachesOutput=new Set(outputs.map(node=>node.id));let changed=true;
    while(changed) {changed=false;for(const edge of workflow.edges) if(reachesOutput.has(edge.to)&&!reachesOutput.has(edge.from)) {reachesOutput.add(edge.from);changed=true;}}
    if(reachesOutput.size!==workflow.nodes.length) fail('每个分支都必须连接到输出节点');
  }
  return order;
}
function sanitizeWorkflow(value:unknown,now:string):Workflow {
  if(!value||typeof value!=='object'||Array.isArray(value)) fail('工作流格式不正确');
  const input=value as Workflow;
  if(!Array.isArray(input.nodes)||!Array.isArray(input.edges)) fail('工作流节点与连接格式不正确');
  if(input.nodes.some(node=>!node||typeof node!=='object')||input.edges.some(edge=>!edge||typeof edge!=='object')) fail('工作流节点或连接格式不正确');
  if(input.kind!==undefined&&input.kind!=='agent'&&input.kind!=='workflow')fail('应用类型不正确');
  const workflow:Workflow={id:optional(input.id,100)||uid('workflow'),name:text(input.name,'工作流名称',100),description:optional(input.description,2000),...(input.kind?{kind:input.kind}:{}),status:'draft',version:Number.isInteger(input.version)?input.version:0,updatedAt:now,nodes:input.nodes.map(node=>({id:node.id,type:node.type,label:node.label,x:node.x,y:node.y,...(node.agentId?{agentId:node.agentId}:{}),...(node.instruction?{instruction:node.instruction}:{}),...(node.knowledgeIds!==undefined?{knowledgeIds:node.knowledgeIds}:{})})),edges:input.edges.map(edge=>({from:edge.from,to:edge.to,...(edge.condition!==undefined?{condition:edge.condition}:{})}))};
  validateWorkflow(workflow);return workflow;
}
function publication(workflow:Workflow):PublishedWorkflow|undefined {
  if(workflow.published)return structuredClone(workflow.published);
  if(workflow.status!=='published')return;
  return {name:workflow.name,description:workflow.description,...(workflow.kind?{kind:workflow.kind}:{}),nodes:structuredClone(workflow.nodes),edges:structuredClone(workflow.edges),version:workflow.version,publishedAt:workflow.updatedAt};
}
function publishedView(workflow:Workflow):Workflow {
  const saved=publication(workflow);if(!saved)fail('此应用尚未发布',403);
  return {id:workflow.id,name:saved.name,description:saved.description,...(saved.kind?{kind:saved.kind}:{}),status:'published',nodes:saved.nodes,edges:saved.edges,version:saved.version,updatedAt:saved.publishedAt};
}
export function routeAgents(query:string):AgentId[] {
  if(/培训|练习|带练|扮演|陪练/.test(query))return ['coach'];
  if(/漏斗|(?:项目|商机|线索)(?:阶段|分布).{0,8}(?:统计|分布|数量|有多少)|(?:项目|商机|线索)(?:的)?(?:一共|共有|总共|目前有|现在有|有)?(?:多少|几个|几家|数量|总数)|(?:统计|多少|几个|几家).{0,8}(?:项目|商机|线索)/.test(query))return ['opportunity'];
  if(/风险|合同|免租|审批|合规|资质|违约|授权/.test(query))return /方案|谈判|回应|话术/.test(query)?['risk','strategy']:['risk'];
  if(/优先|预测|健康|本周|商机|漏斗|推进/.test(query))return ['opportunity'];
  if(/拜访|方案|策略|开场|话术|谈判/.test(query))return ['insight','strategy'];
  return ['insight'];
}
/** A conditional edge needs one intent; main-agent collaboration may select several experts. */
function workflowIntent(query:string):AgentId {
  if(/培训|训练|练习|带练|扮演|陪练/.test(query))return 'coach';
  if(/风险|合同|免租|审批|合规|资质|违约|授权/.test(query))return 'risk';
  if(/商机|预测|漏斗|健康|优先|推进/.test(query))return 'opportunity';
  if(/方案|策略|谈判|拜访|开场|话术/.test(query))return 'strategy';
  return 'insight';
}
function publishedKnowledge(state:Pick<WorkbenchState,'knowledge'|'skills'>):Knowledge[] {
  const entries=state.knowledge.filter(item=>item.status==='published');
  for(const skill of state.skills.filter(item=>item.status==='published')) {
    if(entries.some(item=>item.id===`knowledge-${skill.id}`)) continue;
    entries.push({id:`knowledge-${skill.id}`,title:skill.title,category:skill.category,content:[skill.description,`适用：${skill.scenario}`,skill.steps.join('；'),`边界：${skill.boundaries.join('；')}`].join('\n'),status:'published',source:`已审核Skill · ${skill.reviewer??'销售管理者'}`,updatedAt:skill.updatedAt});
  }
  return entries;
}
export function retrieveKnowledge(state:Pick<WorkbenchState,'knowledge'|'skills'>,query:string):Knowledge[] {
  return rankedKnowledge(publishedKnowledge(state),query);
}
function rankedKnowledge(entries:Knowledge[],query:string):Knowledge[] {
  const terms=new Set(query.match(/[A-Za-z0-9]{2,}/g)??[]);
  for(const segment of query.match(/[\p{Script=Han}]+/gu)??[]) {
    const characters=Array.from(segment);
    for(let index=0;index<characters.length-1;index++)terms.add(characters.slice(index,index+2).join(''));
  }
  return entries.map(item=>({item,score:(query.includes(item.title)?100:0)+[...terms].filter(term=>`${item.title}${item.content}`.includes(term)).length})).filter(entry=>entry.score>0).sort((a,b)=>b.score-a.score).slice(0,4).map(item=>item.item);
}
function chooseDeal(state:WorkbenchState,role:Role,query:string,dealId?:unknown):Deal|undefined {
  // Explicit selections are scoped by stable identity; shared display names are not authorization keys.
  if(dealId) return visibleDeal(state,role,dealId);
  if(role==='sales'&&state.deals.some(deal=>deal.ownerId!==scopeFor(state).salesId&&(
    !!deal.projectName&&query.includes(deal.projectName)||query.includes(deal.name)&&!state.deals.some(own=>own.ownerId===scopeFor(state).salesId&&own.name===deal.name)
  )))fail('当前销售视角无权访问问题中提及的项目',403);
  const matches=state.deals.filter(deal=>!deal.archive&&(query.includes(deal.name)||!!deal.projectName&&query.includes(deal.projectName)));
  const visible=role==='sales'?matches.filter(deal=>deal.ownerId===scopeFor(state).salesId):matches;
  if(matches.length&&!visible.length)fail('当前销售视角无权访问问题中提及的项目',403);
  const named=visible.filter(deal=>deal.projectName&&query.includes(deal.projectName));
  // A company can have several projects. An ambiguous company name must not silently pick one.
  return named.length===1?named[0]:visible.length===1?visible[0]:undefined;
}
const agentName=(id:AgentId)=>AGENTS.find(item=>item.id===id)!.name;
function conversationRuns(state:StoredState,role:Role,value:unknown):Run[] {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>6||value.some(id=>typeof id!=='string'||!id.trim()||id.length>100)||new Set(value).size!==value.length)fail('对话历史格式不正确，最多引用6条运行记录');
  const visible=projectState(state,role).runs;
  return value.map(id=>{
    const existing=find(state.runs,id,'对话记录');
    const run=visible.find(item=>item.id===existing.id);
    if(!run)fail('当前视角无权访问这条对话记录',403);
    if(run.workflowId)fail('对话历史只能引用主对话记录');
    return run;
  });
}
function boundedConversation(runs:Run[]):NonNullable<GenerationInput['history']> {
  const history:NonNullable<GenerationInput['history']>=[];let remaining=20000;
  for(const run of [...runs].reverse()) {
    const turn={query:run.query.slice(0,6000),answer:run.answer.slice(0,4000)};
    const size=turn.query.length+turn.answer.length;if(size>remaining)break;
    history.unshift(turn);remaining-=size;
  }
  return history;
}
const resetsChatTopic = (query:string):boolean =>
  /^(?:(?:好[，,。]|请|我们|咱们)\s*)?(?:换(?:一?个)?话题|新(?:的)?问题|另(?:外)?(?:一?个)?问题|另外问|重新开始)/.test(query);

function isFollowup(query:string):boolean {
  if(resetsChatTopic(query))return false;
  return /他们|她们|它们|该客户|这个客户|这家|那家|对方|上面|上述|刚才|之前的|前面的/.test(query)
    || /^(?:请|麻烦|帮我)?(?:继续|接着|再(?:简短|短|详细|具体|展开|补充|解释|改|写|整理|说明)|还有呢|[他她它](?:的|有|需|预|要|说|会|能|是|呢))/.test(query)
    || /^(?:请|麻烦|帮我)?(?:把|将)?(?:上(?:一)?(?:轮|版|段|条)|前一(?:版|段)|这(?:一)?(?:段|版|条|份答复)|那(?:一)?(?:段|版|条)|原稿|你的回答)/.test(query)
    || /^(?:那|那么|还有)(?:预算|需求|风险|时间|价格|租金|免租|合同|决策人|下一步|呢|？|\?)/.test(query);
}

function isDraftRevision(query:string):boolean {
  return isFollowup(query)&&!/当前|现在|最新|更新数据|重新查|核实|核对|补充证据/.test(query)
    && /改得更|改短|改长|润色|改写|重写|翻译|缩成|缩短|压缩|扩写|调整措辞|整理成|列成|再(?:短|简短)/.test(query);
}

function isPropertyFollowup(query:string):boolean {
  if(resetsChatTopic(query)||/重新(?:找|查|筛选)|不考虑之前|所有(?:房源|铺位)|全部(?:房源|铺位)/.test(query))return false;
  if(parsePropertyPageRequest(query)!==undefined)return true;
  const refinement=/^(?:请|麻烦|帮我)?(?:再加|加上|改成|换成|只看|只要|不要|排除|不考虑|面积|业态|位置|区域|楼层|看看还有|还有|那|再找|继续查|继续筛|接着查|接着筛)/;
  const condition=/面积|业态|位置|区域|楼层|餐饮|零售|空置|在租|[\p{Script=Han}\d]{1,12}(?:园区|街区|商圈|区|楼|层)|\d+(?:\.\d+)?\s*(?:平米|平方米|㎡|m²|m2|平)/iu;
  return refinement.test(query)&&(isPropertyQuestion(query)||condition.test(query));
}

/** Start with the newest turn and retain only the same subject up to its first self-contained question. */
function currentChatThread(runs:Run[],dealId?:string):Run[] {
  const thread:Run[]=[];
  for(const run of [...runs].reverse()) {
    if(run.dealId!==dealId||!isCompletedChatRun(run))break;
    thread.unshift(run);
    if(resetsChatTopic(run.query)||!(run.answerSource==='property-records'?isPropertyFollowup(run.query):isFollowup(run.query)||isCustomerRecordFollowup(run.query)))break;
  }
  return thread;
}
export function demoGenerate(input:GenerationInput):GenerationOutput {
  const {agentId,deal,query,deals,knowledge,instruction}=input;
  if(input.purpose==='chat')return {answer:'未调用外部模型。大模型当前不可用，请在设置的「服务连接」核对模型配置后重试。',mode:'demo'};
  const name=deal?.name??'当前项目';
  const facts=deal?`${deal.projectName?`${deal.projectName} · `:''}${name}目前处于${deal.stage}阶段。已记录的需求：${deal.needs.length?deal.needs.join('、'):'尚未填写，需与客户确认'}。`:'以下为通用销售沟通建议，具体企业资料、采购需求和授权条件尚未确认。';
  const missing=deal?.risks.length?deal.risks.join('；'):'预算、采购时间与最终决策人尚需确认';
  let answer='';
  if(agentId==='insight') answer=`${facts}\n\n客户洞察：${deal?.summary||'先确认客户业务目标、现有流程中的问题、采购预算与交付时间，再与使用部门及采购决策人核对优先事项。'}${deal?.companyProfile?`\n\n企业公开资料：${deal.companyProfile.summary} 仅依据已列明的外部来源，待核实事项不作事实结论。`:''}\n\n待核实的问题：${deal?.contact?`与${deal.contact}确认谁提出需求、谁审批预算、谁决定采购；${missing}。`:'谁提出需求、谁审批预算、谁有最终决策权？正在比较哪些方案，最晚何时完成采购？'}\n\n建议下一步：${deal?.nextAction||'约一次包含需求人与决策人的沟通，整理已确认事实、待核实事项与下一步责任人。'}`;
  if(agentId==='strategy') answer=`${facts}\n\n沟通目标：将客户最关心的条件变成可验证的清单，并约定具体的下一步。\n\n建议议程：先复述${deal?.needs[0]||'业务目标与核心需求'}，再核对预算、采购流程、交付时间和决策标准，最后比较两种授权内方案并确认责任人。\n\n开场可以说：“我先确认一下，${deal?.needs[0]||'业务目标和交付要求'}是否仍是这次采购的优先项？我们把尚未确认的条件列清，再决定如何推进。”\n\n跟进行动：${deal?.nextAction||'会后发送事实清单与可比较方案，并约定下次确认时间。'} 涉及折扣、交付承诺或合同特殊条件的事项须按正式授权审核。`;
  if(agentId==='risk') answer=`${facts}\n\n需要核对的商务风险：${deal?.risks.length?deal.risks.join('；'):/免租/.test(query)?'免租诉求是否超出当前项目的正式授权；装修周期与商业优惠是否混用；交付日期是否已书面确认。':'折扣授权、交付责任、验收标准和付款条款是否有正式依据。'}\n\n处理建议：将诉求拆成“已确认事实、待核实条件、需要审批事项”，请对应负责人给出书面结论。\n\n对客户可以说：“我会把您的目标、交付安排和总成本一起核算；超出授权的条件需要内部审批，我会给出明确的反馈时间。”\n\n本地建议依据当前输入整理，不替代法务或主管部门的专业确认。`;
  if(agentId==='opportunity') {
    const ranked=[...(deal?[deal]:deals)].sort((a,b)=>(a.priority==='high'?-1:1)-(b.priority==='high'?-1:1)||b.health-a.health).slice(0,3);
    answer=`建议优先核实以下项目的下一步：\n\n${ranked.map((item,index)=>`${index+1}. ${item.projectName??item.name}（${item.stage}，${item.health?`信息健康度${item.health}/100`:'健康度尚未评估'}）：${item.nextAction||'确认需求、预算与下一次沟通安排'}。依据：${item.summary||'项目信息待补充'} 风险缺口：${item.risks.join('；')||'尚待核实'}。`).join('\n\n')}\n\n健康度只提示信息完整度和跟进顺序，不是成交概率。客户确认预算、决策人和下一步后，再由销售手动确认是否推进阶段。`;
  }
  if(agentId==='coach') answer=`练习场景：${deal?.name??'客户'}对报价或采购价值提出异议。\n\n客户会说：“我们还在比较几家方案。你们的价格更高，我需要先弄清楚，多出的投入能解决什么问题？”\n\n建议先回应客户对投入产出的顾虑，再确认当前问题、预算、采购标准和交付要求，用有依据的方案说明价值，最后约定下一步。不要承诺未经审批的条件。\n\n进入“培训带练”可先确认客户画像，再开展多轮客户对话并查看复盘。`;
  if(instruction) answer+=`\n\n本节点配置重点：${instruction}`;
  if(knowledge.length) answer+=`\n\n参考资料：${knowledge.map(item=>item.title).join('、')}。资料的适用行业与授权范围须另行核对。`;
  return {answer:`本地生成 · 未调用外部模型\n\n${answer}`,mode:'demo'};
}
const knowledgeBoundary=(route:KnowledgePreparedContext['route']):string=>({direct:'本次可直接沟通，无需补充业务事实。',retrieved:'仅按本次已授权资料回答业务事实，保留适用条件；客户预算不是产品报价。',conflict:'资料存在冲突，请人工核实后再确认业务条件。',failed:'资料暂时不可用，请稍后核实；当前无法确认业务事实。',no_evidence:'现有资料不足，尚无法确认业务事实，请补充资料或人工核实。'})[route];
const customerAdvice=(query:string,deals:Deal[])=>deals.length>0&&/建议|策略|方案|推进|分析|风险|跟进|商机|漏斗|健康/.test(query);
const outputSentences=(value:string)=>value.split(/(?<=[。！？!?；;])|\n/).map(s=>s.replace(/^\s*(?:#{1,6}\s+|[-*]\s+|\d+[.)、]\s*)/,'').trim()).filter(Boolean);
/** Customer statements can ground their own attributed requirements, never vendor facts. */
function customerFactSupported(clause:string,input:GenerationInput):boolean {
  const normalize=(value:string)=>value.replace(/[。！!？?；;\s]/g,'');
  const deals=input.deal?[input.deal]:input.deals;
  const claim=normalize(clause);
  return deals.some(deal=>{
    const subjects=[deal.name,`客户${deal.name}`,`${deal.name}客户`,...(input.deal||deals.length===1?['客户','该客户']:[])];
    const profile=deal.customerProfile;
    const fields:[string[],string[]][]=[
      [['预算','租金预算'],[profile?.budget??'']],
      [['计划时间','时间'],[profile?.timeline??'']],
      [['目标'],[profile?.goals??'']],
      [['顾虑'],[profile?.concerns??'']],
      [['决策链'],[profile?.decisionChain??'']],
      [['需求','需要','希望'],deal.needs],
    ];
    return fields.some(([labels,values])=>values.filter(value=>value.trim()).some(value=>subjects.some(subject=>
      labels.some(label=>['','为','是','：',':'].some(join=>claim===normalize(`${subject}${label}${join}${value}`)))||
      // A need may already carry its own field label (e.g. “需要80平米”).
      /^(?:需要|希望|预算|面积|区域)/.test(value)&&claim===normalize(`${subject}${value}`)
    )));
  });
}
const normalizedClaim=(value:string)=>value.normalize('NFKC').replace(/[。！!？?；;\s]/g,'');

function includesSourceSentence(answer:string,knowledge:Knowledge):boolean {
  const sentences=new Set(outputSentences(answer).map(normalizedClaim));
  return outputSentences(knowledge.content).some(sentence=>normalizedClaim(sentence).length>=4&&sentences.has(normalizedClaim(sentence)));
}

const applicabilityStatements=(content:string)=>outputSentences(content).filter(part=>/仅|适用|前提|须|必须|条件|如果|限于/.test(part));

function groundedSpecialist(answer:string,input:GenerationInput,strictBusiness:boolean):boolean {
  const factual=/租金|月租|价格|单价|库存|空铺|房源|地址|营业|开门|政策|制度|审批|收费|转让费|支持|预约成功|保证|已(?:预约|确认|安排)|(?:有|剩|可租).{0,8}(?:商铺|房|铺)|报价|折扣|优惠|押金|免租|现货|有货|都有|随时有|可用库存|每月|预算.{0,12}(?:元|万|千|百|块)|\d/;
  return outputSentences(answer).every(sentence=>{
    if(/^(?:已核对|资料不足|尚待核实|请补充资料|需要人工确认)[。！!]*$/.test(sentence))return true;
    if(input.portfolio&&isPortfolioCount(sentence))return verifiedPortfolioCount(sentence,input.portfolio);
    const sources=input.knowledge.filter(item=>outputSentences(item.content).some(part=>normalizedClaim(part)===normalizedClaim(sentence)));
    // A price sentence cannot be detached from its source's applicability clauses.
    if(sources.some(item=>[...applicabilityStatements(item.content),...(item.applicability??[])].every(part=>answer.includes(part))))return true;
    if(input.knowledge.some(item=>item.applicability?.some(part=>normalizedClaim(part)===normalizedClaim(sentence))
      && includesSourceSentence(answer,item)))return true;
    const sectionLabel=/^(?:结论|依据|适用条件|建议|下一步|待核实)[：:]?$/;
    const verification=/^(?:建议先|可以先|请先|请)?(?:联系|询问|确认|核实|核对|查看|查阅|提供|补充|了解)[^，,。；;：:\d]{1,70}[。？?]?$/;
    const commitment=/已有|已(?:经|确认|获批|通过|安排|预约)|保证|肯定|必然|可直接享受|[零〇一二两三四五六七八九十百千万亿]+\s*(?:元|折|间|套|平米)/;
    if(sectionLabel.test(sentence)||verification.test(sentence)&&!commitment.test(sentence))return true;
    if(strictBusiness)return false;
    // Check every clause so an owned budget cannot launder a following inventory/price claim.
    return sentence.split(/[，,]/).filter(Boolean).every(clause=>!factual.test(clause)||customerFactSupported(clause,input));
  });
}
function groundedChatGuidance(sentence:string,input:GenerationInput):boolean {
  if(input.portfolio&&isPortfolioCount(sentence))return false;
  const missingCustomer=/本轮没有选定客户或项目/.test(input.instruction??'');
  const clarification=missingCustomer&&/^(?:请问|你想|您想|要调研|想调研|哪家|哪个)[^。！]{1,70}[？?]$/.test(sentence)&&/客户|公司|项目/.test(sentence);
  const uncertainty=/^(?:(?:我(?:手上|目前|暂时)?|本轮|目前|现有资料|查到的资料|暂时|现在|仅凭[^，,。！？]{1,40})(?:还|暂时|没有|未能|没找到|不足以|没有足够|不能|无法|未找到)|无法|还不能|尚不能|没有找到|查不到)[^；;。！？\n]{1,120}[。！]?$/.test(sentence)&&/确认|判断|核实|断定|资料|证据|记录|依据/.test(sentence);
  const generalMethod=/^(?:一般来说|通常|常见|通用|可以参考).{2,120}$|^[^，,。！？；]{2,32}(?:通常|一般|常见)(?:包括|涉及|分为|可以|先|会|由).{2,100}$/.test(sentence)&&
    !/本(?:公司|项目|园区)|我方|贵司|这个项目|该公司|这家|我们|你们|客户.{0,5}(?:计划|决定|有|需)/.test(sentence);
  const action=/^(?:(?:一般来说|建议|可以|可|请|不妨|最好|先|再|并|优先)\s*)*(?:(?:把|将|向|与|通过)[^，,。！？；]{1,32})?(?:联系|查询|查看|记录|整理|收集|核实|核对|确认|询问|问|列出|比较|检查|准备|保存|告诉|提供|约|评估|梳理)/;
  const unsafe=/[\d<>]|https?:|\bwww\.|(?:已(?:经|确认|获批|通过|安排|预约)|必须|统一|保证|肯定|必然|可直接享受)|(?:规定|要求|制度|标准|期限)(?:为|是|必须|应当)|[零〇一二两三四五六七八九十百千万亿]+\s*(?:个?工作日|天内|元|折|间|套|平米)/;
  const actions=sentence.replace(/^(?:如果|若|一般来说)[^，,]{0,60}[，,]/,'').split(/[，,]/).map(part=>part.trim());
  return !unsafe.test(sentence)&&(clarification||uncertainty||generalMethod||actions.every(part=>action.test(part)));
}
function retainGroundedChatAnswer(answer:string,input:GenerationInput,advisory:boolean):string {
  const sentences=outputSentences(answer);
  const claims=new Set(sentences.map(normalizedClaim));
  const usableKnowledge=input.knowledge.filter(item=>[...applicabilityStatements(item.content),...(item.applicability??[])].every(part=>claims.has(normalizedClaim(part))));
  const usedKnowledge=usableKnowledge.filter(item=>includesSourceSentence(answer,item));
  const verified=new Set(usedKnowledge.flatMap(item=>[...outputSentences(item.content),...(item.applicability??[])].map(normalizedClaim)));
  const adviceContext={...input,knowledge:[]};
  const accepted=sentences.filter(sentence=>verified.has(normalizedClaim(sentence))||groundedSpecialist(sentence,adviceContext,!advisory)||groundedChatGuidance(sentence,adviceContext));
  return accepted.length===sentences.length?answer:accepted.join('\n\n');
}
async function boundedSpecialist(input:GenerationInput,context:ActionContext,route?:KnowledgePreparedContext['route'],directAnswer?:string):Promise<GenerationOutput>{
  const generate=context.generate??(async (request:GenerationInput)=>demoGenerate(request));
  if(!route)return generate(input);
  if(route==='direct'){
    if(directAnswer)return {answer:directAnswer,mode:'demo'};
    return generate(input);
  }
  const boundary=knowledgeBoundary(route);
  const advisory=Boolean(input.portfolio)||customerAdvice(input.query,input.deals);
  if((input.purpose!=='chat'||!context.generate)&&(route==='conflict'||route!=='retrieved'&&!advisory))return {answer:boundary,mode:'demo'};
  const hasEvidence=route==='retrieved';
  const guidance=input.portfolio
    ? '项目组合是本轮已授权的业务资料。组合统计请逐行使用所给的统计表述。可依据所给部分项目建议下一步。只在引文支持时陈述政策、报价等额外业务事实。'
    : hasEvidence
    ? '回答当前问题。涉及业务的可核实事实请引用本轮资料的完整原句并保留适用条件。可单独组织结论和通用下一步建议。'
    : '按用户的提问用自然语言写出完整回答。如果需要说明证据不足或资料冲突，请用自己的话简短交代具体不能确认什么，并继续完成能回答的部分。可以给出通用方法、条件分析、可执行建议或需要补充的信息。把有依据的事实和建议分别写成独立句子。';
  const knowledgeStatus=input.portfolio&&!hasEvidence?'知识库未提供本轮可用的业务事实，已授权的项目组合仍可作为统计和跟进建议的依据。':boundary;
  const request={...input,knowledge:hasEvidence?input.knowledge:[],instruction:[input.instruction,knowledgeStatus,guidance,'客户预算只代表客户需求，不能作为报价、库存、制度或执行结果的依据。'].filter(Boolean).join('\n')};
  const format=(output:GenerationOutput):GenerationOutput|undefined=>{
    const supported=groundedSpecialist(output.answer,request,!advisory);
    const retained=supported?output.answer:input.purpose==='chat'&&output.mode==='live'?retainGroundedChatAnswer(output.answer,request,advisory):'';
    if(!retained)return undefined;
    const evidenceIds=request.knowledge.filter(item=>includesSourceSentence(retained,item)).map(item=>item.id);
    const prefix=input.purpose==='chat'?'':!hasEvidence?boundary:evidenceIds.length?'':knowledgeBoundary('no_evidence');
    return {...output,answer:[prefix,retained].filter(Boolean).join('\n\n'),evidenceIds,groundingRejected:!supported&&retained!==output.answer};
  };
  const output=await generate(request);
  if(output.mode==='demo'&&input.purpose==='chat')return demoGenerate(request);
  const formatted=format(output);
  const needsCounts=Boolean(input.portfolio&&isPortfolioCountQuestion(input.query));
  const answersCount=(candidate:GenerationOutput|undefined)=>Boolean(candidate&&input.portfolio&&outputSentences(candidate.answer).some(sentence=>verifiedPortfolioCount(sentence,input.portfolio!)));
  if(formatted&&(!needsCounts||answersCount(formatted)))return formatted;
  if(input.purpose==='chat'&&context.requireNarrative){
    try{
      const retryInstruction=input.portfolio?'请重新回答。需要给数量时，将「范围统计」中与问法相关的已核对统计逐条原样写出，每项独立一行。仅就本轮提供的部分项目提出建议。':'请用自己的话重新回答。略去无法核实的事实，直接给出仍可执行的做法或需要用户补充的信息。';
      const retry=await generate({...request,instruction:`${request.instruction}\n${retryInstruction}`});
      const repaired=retry.mode==='live'?format(retry):undefined;
      if(repaired&&(!needsCounts||answersCount(repaired)))return repaired;
    }catch(error){if(!(error instanceof DomainError))throw error;}
  }
  if(input.portfolio&&needsCounts&&output.mode==='live'){
    return {answer:portfolioCountFallback(input.portfolio,input.query),mode:'demo',modelName:output.modelName,groundingRejected:true,evidenceIds:[]};
  }
  return {answer:hasEvidence?'回答中的业务事实缺少完整资料依据，请核实后回复。':boundary,mode:'demo',modelName:output.modelName,groundingRejected:output.mode==='live'};
}
const asKnowledge=(item:KnowledgeAgentEvidence):GenerationKnowledge=>{
  const content=item.excerpt??item.content;
  const applicability=item.excerpt?applicabilityStatements(item.content).filter(part=>!content.includes(part)):[];
  return {id:item.id,title:item.title,content,category:'共享知识库',source:'已授权知识库',status:'published',updatedAt:'',
    ...(applicability.length?{applicability:applicability.slice(0,8)}:{})};
};

type CustomerInsightKind='profile'|'records'|'demand';
async function generateCustomerInsight(input:GenerationInput,deal:Deal,generate:NonNullable<ActionContext['generateInsight']>,kind:CustomerInsightKind,demandEvidenceQuery:string,demandConflict:boolean,publicEvidence?:CustomerInsightEvidence[],publicSearchStatus?:string,requireNarrative=false):Promise<GenerationOutput> {
  const libraryEvidence=input.knowledge.filter(item=>item.category==='共享知识库').map(item=>({
    id:item.id,label:'已授权知识库摘录',value:item.content,source:item.title,sourceIds:[item.id],
  }));
  const recordsEvidence=kind==='records'?publicEvidence??[]:[];
  const evidence=kind==='records'?recordsEvidence:demandConflict?[]:[
    ...(kind==='demand'?customerDemandEvidence(deal):customerInsightEvidence(deal)),
    ...libraryEvidence,
  ];
  const instruction=kind==='records'?[CUSTOMER_RECORD_INSTRUCTION,publicSearchStatus].filter(Boolean).join('\n'):kind==='demand'
    ? [CUSTOMER_DEMAND_INSTRUCTION,demandConflict?'本轮有适用条件相同但结论冲突的资料，status 必须为 unconfirmed，请给出核实办法。':'',publicSearchStatus,
      publicEvidence?.some(item=>item.id.startsWith('expansion-web-'))?'如果用户要求搜索，可以用正文中的来源标记引用和当前问题相关的公开线索。公开摘要只作为待核实线索。':''].filter(Boolean).join('\n')
    : CUSTOMER_INSIGHT_INSTRUCTION;
  const libraryIds=new Set(libraryEvidence.map(item=>item.id));
  const request={...input,knowledge:[],previous:'',instruction,customerInsightEvidence:evidence,publicCompanyEvidence:kind==='records'?undefined:publicEvidence,
    ...(kind==='records'?{salesScope:undefined}:{})};
  const sourceIds=(item:CustomerInsightEvidence,companySource:boolean)=>(item.sourceIds??[]).map(id=>companySource?`company-${deal.id}-${id}`:id);
  const profiles=(kind==='demand'?publicEvidence??[]:evidence.filter(item=>!libraryIds.has(item.id)))
    .filter(item=>item.sourceIds?.length&&!item.id.startsWith('expansion-web-'));
  const profileRequested=kind==='profile'||kind==='demand'&&isCustomerProfileRequest(input.query);
  const quote=(item:CustomerInsightEvidence)=>`> ${formatCustomerEvidenceQuote(item,true)}`;
  const unresolvedDemand='现有资料尚未确认客户对这件事的实际需求。';
  const unresolvedRecords='现有资料还不足以确认这家公司的相关记录。';
  const format=(raw:string):GenerationOutput|undefined=>{
    if(kind==='records'){
      const result=formatCustomerRecordResult(raw,requireNarrative,recordsEvidence);
      if(!result)return undefined;
      const chosen=recordsEvidence.filter(item=>result.factIds.includes(item.id));
      const displayed=chosen.length?chosen:recordsEvidence.slice(0,2);
      const scope=!recordsEvidence.length&&!/(?:不能|无法|尚未|还未|不足以|仍待|待核实|待确认|不确定|不能据此|不清楚|未能|未知)/.test(result.answer)
        ?unresolvedRecords:'';
      const answer=[scope,result.answer,...(chosen.length?[]:displayed.map(quote))].filter(Boolean).join('\n\n');
      return {answer,mode:'live',groundingRejected:result.groundingRejected,evidenceIds:displayed.map(item=>item.id)};
    }
    const formatted=kind==='demand'?formatCustomerDemand(raw,evidence,demandEvidenceQuery,publicEvidence,requireNarrative):formatCustomerInsightResult(raw,evidence,requireNarrative);
    if(!formatted)return undefined;
    const selected=new Set(formatted.factIds);
    const evidenceIds=evidence.filter(item=>selected.has(item.id)).flatMap(item=>sourceIds(item,kind==='profile'&&!libraryIds.has(item.id)));
    const publicIds=new Set('profileFactIds' in formatted?formatted.profileFactIds as string[]:[]);
    if('profileFactIds' in formatted){
      for(const item of publicEvidence??[])if(publicIds.has(item.id))evidenceIds.push(...sourceIds(item,true));
    }
    const additions:string[]=[];
    if(requireNarrative&&profileRequested&&!profiles.some(item=>selected.has(item.id)||publicIds.has(item.id))){
      const unusedProfile=profiles.slice(0,3);
      if(unusedProfile.length){
        additions.push(unusedProfile.map(quote).join('\n\n'));
        evidenceIds.push(...unusedProfile.flatMap(item=>sourceIds(item,true)));
      }
    }
    if(requireNarrative&&kind==='demand'&&(profileRequested||formatted.groundingRejected)&&!selected.size&&
      !/(?:尚未确认|无法确认|无法判断|未能确认|还不能确认|还不能判断|没有[^。！？]{0,20}(?:直接|明确)?(?:证据|记录))/.test(formatted.answer))additions.push(unresolvedDemand);
    return {answer:[formatted.answer,...additions].join('\n\n'),mode:'live',evidenceIds,groundingRejected:formatted.groundingRejected};
  };
  const result=await generate(request);
  if(result.mode!=='live')fail('客户洞察需要大模型。请在设置的「服务连接」中配置并启用大模型后重试。',503);
  const formatted=format(result.answer);
  if(formatted)return {...formatted,modelName:result.modelName};
  if(requireNarrative){
    try{
      const retryInstruction=kind==='records'
        ?'请只写两句普通中文正文：一句直接说明资料范围或待核实的问题，一句给出下一步。涉及具体记录时另起一行写 > [[证据ID]]，勿复述具体事实。'
        :'请重新写出简明的 answer 正文。先用自然语言回答资料能够支持的部分，无法核实的企业事实请省略。直接展示原文时，只用已提供的来源标记。';
      const retry=await generate({...request,instruction:`${instruction}\n${retryInstruction}`});
      const repaired=retry.mode==='live'?format(retry.answer):undefined;
      if(repaired)return {...repaired,modelName:retry.modelName};
    }catch(error){if(!(error instanceof DomainError))throw error;}
    const companyFacts=profileRequested?profiles.slice(0,3):[];
    const records=kind==='demand'?evidence.filter(item=>supportsDemand(item,demandEvidenceQuery)).slice(0,2):[];
    const webClues=(publicEvidence??[]).filter(item=>item.id.startsWith('expansion-web-')).slice(0,2);
    const recordClues=recordsEvidence.slice(0,3);
    const answer=[
      companyFacts.length?'本轮查到的企业资料。':profileRequested?'本轮没有取得可引用的企业画像资料。':'',
      ...companyFacts.map(quote),
      kind==='demand'?(records.length?'项目里有以下相关记录，当前情况仍需向客户核实。':unresolvedDemand):'',
      ...records.map(quote),...webClues.map(quote),
      kind==='records'?publicSearchStatus??'':'',
      kind==='records'&&!recordClues.length?unresolvedRecords:'',
      ...recordClues.map(quote),
      '模型未能提供可核实的完整分析。',
    ].filter(Boolean).join('\n\n');
    return {answer,mode:'demo',modelName:result.modelName,groundingRejected:true,evidenceIds:[
      ...[...companyFacts,...webClues].flatMap(item=>sourceIds(item,true)),...records.flatMap(item=>sourceIds(item,false)),...recordClues.map(item=>item.id),
    ]};
  }
  fail('大模型已返回内容，但答复未通过资料核对。请重试或缩小问题范围。',502);
}
async function buildRun(state:StoredState,role:Role,query:string,context:ActionContext,now:string,options:{agentId?:unknown;dealId?:unknown;conversationRunIds?:unknown;talkTrackIds?:unknown}={}):Promise<Run> {
  const started=Date.now();const steps:TraceStep[]=[];const citations:Run['citations']=[];const usedAgents:AgentId[]=[];let mode:Run['mode']='demo';let groundingRejected=false;const answers:string[]=[];
  const emit=(event:ChatProgressStep)=>{
    try { context.onChatProgress?.(event); } catch { /* A detached progress reader cannot change the run. */ }
  };
  const startPhase=(title:string,detail:string,agent?:AgentId)=>{
    const id=uid('step');const began=Date.now();
    const report=(status:ChatProgressStep['status'],detail:string)=>emit({id,title,detail,status,duration:Date.now()-began,...(agent?{agent}:{})});
    report('running',detail);
    let finished=false;
    const finish=(status:TraceStep['status'],detail:string)=>{
      if(finished)return;
      finished=true;
      report(status,detail);
    };
    return {
      id,
      finish,
      async wait<T>(operation:()=>Promise<T>):Promise<T> {
        try { return await operation(); }
        catch(error) { finish('error','本步骤未完成。'); throw error; }
      },
    };
  };
  const step=(title:string,detail:string,status:TraceStep['status']='success',agent?:AgentId,duration=0,phase?:ReturnType<typeof startPhase>,progressDetail?:string)=>{
    steps.push({id:phase?.id??uid('step'),title,detail,status,agent,duration});
    phase?.finish(status,progressDetail??(status==='warning'?'本步骤部分完成。':'已完成。'));
  };
  const priorRuns=conversationRuns(state,role,options.conversationRunIds);
  const latest=priorRuns.at(-1);
  const namedDeal=chooseDeal(state,role,query,options.dealId);
  const wholePortfolio=!options.dealId&&isWholePortfolioQuery(query)&&
    (options.agentId==='opportunity'||options.agentId===undefined&&routeAgents(query).includes('opportunity'));
  const directDeal=wholePortfolio?undefined:namedDeal;
  const sameContext=!!latest&&isCompletedChatRun(latest)&&(!wholePortfolio||!latest.dealId)&&(!directDeal||directDeal.id===latest.dealId)&&!resetsChatTopic(query);
  const thread=sameContext?currentChatThread(priorRuns,latest!.dealId):[];
  const priorTopic = sameContext && latest?.dealId && isCustomerRecordFollowup(query) ? thread.findLast(run =>
    !run.agentIds.includes('insight') || !isCustomerRecordFollowup(run.query)) : undefined;
  const recordTopic = priorTopic?.agentIds.includes('insight') && isCustomerRecordQuestion(priorTopic.query) ? priorTopic : undefined;
  const revision=sameContext&&isDraftRevision(query);
  const demandAnchor=thread.findLast(run=>!isCustomerDemandFollowup(run.query));
  const demandDeal=directDeal??(sameContext&&latest?.dealId&&(isFollowup(query)||isCustomerDemandFollowup(query))
    ?chooseDeal(state,role,query,latest.dealId):undefined);
  const demandContinuation=Boolean(demandDeal&&demandAnchor&&isCustomerDemandFollowup(query)&&isCustomerDemandQuestion(demandAnchor.query,demandDeal.name));
  const demandQuestion=!revision&&Boolean(demandDeal&&(demandContinuation||isCustomerDemandQuestion(query,demandDeal.name)));
  const missingDemandSubject=!revision&&!demandDeal&&isCustomerDemandQuestion(query);
  const demandEvidenceQuery=demandContinuation?`${query}\n${demandAnchor!.query}`:query;
  const propertyContinuation=sameContext&&!revision&&!demandQuestion&&latest?.answerSource==='property-records'&&isPropertyFollowup(query);
  const explicitPropertyQuestion=!revision&&!demandQuestion&&!missingDemandSubject&&isPropertyQuestion(query);
  const propertyQuestion=explicitPropertyQuestion||propertyContinuation;
  const profileAndDemand=demandQuestion&&isCustomerProfileRequest(query);
  const refreshProfile=!revision&&!propertyQuestion&&isCustomerProfileRefreshRequest(query);
  const followup=sameContext&&(demandContinuation||propertyContinuation||!explicitPropertyQuestion&&(!demandQuestion||!directDeal)&&(isFollowup(query)||!!recordTopic));
  const deal=directDeal??(followup?chooseDeal(state,role,latest!.query,latest!.dealId):undefined);
  const history=revision?boundedConversation([latest!]):followup?boundedConversation(thread):[];
  if(options.agentId!==undefined&&!agentIds.has(options.agentId as AgentId))fail('请选择五位领域专家之一');
  const checkRecords = !revision && !propertyQuestion && !demandQuestion && !!deal &&
    (isCustomerRecordQuestion(query) || recordTopic?.dealId === deal.id);
  const recordQuery=recordTopic&&checkRecords?`${query}\n${recordTopic.query}`:query;
  const missingRecordSubject=!deal&&!revision&&!propertyQuestion&&isCustomerRecordQuestion(query)&&
    /公司|企业|客户|商户|他们|对方|门店|^(?:他|她|它)(?:有|是|曾)|[\p{Script=Han}]{2,}(?:有限公司|集团)/u.test(query);
  if (checkRecords && !context.generateInsight) fail('客户洞察需要大模型。请在设置的「服务连接」中配置并启用大模型后重试。', 503);
  const explicitIntent=/培训|练习|带练|扮演|陪练|风险|合同|免租|审批|合规|资质|违约|授权|优先|预测|健康|本周|商机|漏斗|推进|拜访|方案|策略|开场|话术|谈判/.test(query);
  const inheritedRoute=followup&&!explicitIntent?latest!.agentIds.filter(id=>agentIds.has(id)):[];
  const routed:AgentId[]=checkRecords||deal&&(demandQuestion||refreshProfile)?['insight']:options.agentId?[options.agentId as AgentId]:inheritedRoute.length?inheritedRoute:routeAgents(query);
  const previousInsight = followup && latest?.dealId === deal?.id && latest?.agentIds.includes('insight')
    ? thread.findLast(run => run.agentIds.includes('insight') && isCustomerInsightQuestion(run.query))
    : undefined;
  const insightKind:CustomerInsightKind=checkRecords?'records':demandQuestion?'demand':'profile';
  const insightGenerator = !revision && !propertyQuestion && deal && routed.includes('insight') && (checkRecords || demandQuestion || refreshProfile || isCustomerInsightQuestion(query, previousInsight?.query)) ? context.generateInsight : undefined;
  if(demandQuestion&&deal&&!insightGenerator)fail('客户需求调研需要大模型。请在设置的「服务连接」中配置并启用大模型后重试。',503);
  const retrievalQuery=followup&&!propertyQuestion?[...new Set([history[0]?.query,latest!.query,query])].filter(Boolean).join('\n'):query;
  const explicitTracks=approvedTracks(state,options.talkTrackIds,role,state._access??{});
  const routePhase=startPhase('主 Agent 识别意图','正在整理本轮问题和对话范围。');
  step('主 Agent 识别意图',`${role==='manager'?'销售管理者':'销售'}主 Agent ${options.agentId?'按指定专家':inheritedRoute.length?'沿用当前对话专家':'按问题关键词路由'}至${routed.map(agentName).join('、')}。`,'success',undefined,0,routePhase,'已确定本轮处理范围。');
  const recall=revision || checkRecords || demandQuestion || missingDemandSubject || propertyQuestion ? undefined : context.recallAgentMemory;
  const memoryPhase=recall?startPhase('读取 Agent 记忆','正在读取与本轮问题相关的记忆。'):undefined;
  const agentMemory=recall&&memoryPhase?await memoryPhase.wait(()=>recall(retrievalQuery,deal?.id)):undefined;
  if(agentMemory?.index.length)step('读取 Agent 记忆',`加载 ${agentMemory.index.length} 个主题索引，读取 ${agentMemory.topics.length} 条相关经验。`,'success',undefined,0,memoryPhase,'已读取相关记忆。');
  else memoryPhase?.finish('success','本轮没有使用相关记忆。');
  const preferenceRecall = !!agentMemory?.topics.length &&
    /我(?:平时|通常|惯用|偏好|习惯|的(?:惯例|习惯|偏好|风格|格式))|记忆里.{0,15}(?:偏好|习惯|惯例|格式|风格)/.test(query) &&
    !/报价|价格|租金|库存|政策|制度|合同|折扣|优惠|免租|预算|审批|合规|资质|处罚|违规|违法/.test(query);
  const needsSharedKnowledge = !revision && !missingDemandSubject && !missingRecordSubject && !preferenceRecall;
  const portfolio=routed.includes('opportunity')&&/项目|商机|漏斗|客户|团队|招商|销售|跟进/.test(retrievalQuery);
  const scopedDeals=deal?[deal]:[];
  const scopedPortfolio=!deal&&portfolio&&!revision?buildChatPortfolio(
    state.deals.filter(item=>!item.archive&&(role!=='sales'||item.ownerId===scopeFor(state).salesId)),role,query,retrievalQuery,now,
  ):undefined;
  const retrieveTalkTracks=!context.prepareKnowledge&&!explicitTracks.length&&routed.includes('strategy')?context.retrieveTalkTracks:undefined;
  const beginKnowledge=()=>startPhase('检索生效知识','正在核对本轮可用的授权资料。');
  let knowledgePhase=retrieveTalkTracks?beginKnowledge():undefined;
  const semanticTracks=retrieveTalkTracks&&knowledgePhase?await knowledgePhase.wait(()=>retrieveTalkTracks(retrievalQuery)):[];
  const tracks=[...new Map([...explicitTracks,...semanticTracks].map(t=>[t.id,t])).values()].slice(0,5);
  let knowledge:GenerationKnowledge[]=[];
  let expansionProfile:CompanyProfile|undefined;
  let publicSearchStatus:string|undefined;
  let publicCompanyEvidence:CustomerInsightEvidence[]|undefined;
  let recordStatus:string|undefined;
  let recordEvidence:CustomerInsightEvidence[]=[];
  const generate=async (agentId:AgentId,instruction?:string,previous=answers.join('\n\n'))=> {
    const tick=Date.now();const input:GenerationInput={salesScope:context.salesScope,query,agentId,deal,deals:scopedDeals,portfolio:scopedPortfolio,knowledge,instruction:[instruction,revision?'只改写上一轮输出的表达或格式，保留原文的适用条件与不确定性，不新增事实、数字、引文或承诺。':undefined,explicitTracks.length?'用户指定采用以下已审核话术的结构和表达方式：'+explicitTracks.map(t=>t.title).join('、')+'。根据当前客户资料改写占位符，不照搬来源项目事实。':undefined].filter(Boolean).join('\n'),previous,history,...(agentId==='risk'&&deal?{contractReviews:(state.contracts??[]).filter(c=>c.dealId===deal.id&&c.analysis).slice(0,5).map(c=>({title:c.title,reviewedAt:c.reviewedAt,analysis:c.analysis!}))}:{}),purpose:'chat'};
    const scopedInsight=agentId==='insight'&&deal&&insightGenerator;
    if(agentMemory) input.agentMemory=agentMemory;
    if(checkRecords)input.history=recordTopic?[{query:recordTopic.query,answer:''}]:[];
    const requiresBusinessGrounding=missingDemandSubject||missingRecordSubject||Boolean(scopedPortfolio&&(!prepared||prepared.route==='direct'));
    const generationPhase=startPhase(`${agentName(agentId)}生成`,'正在生成本轮答复。',agentId);
    const output=await generationPhase.wait(()=>scopedInsight
      ? generateCustomerInsight(input,deal,insightGenerator,insightKind,demandEvidenceQuery,insightKind==='demand'&&prepared?.route==='conflict',checkRecords?recordEvidence:publicCompanyEvidence,checkRecords?recordStatus:publicSearchStatus,context.requireNarrative)
      : boundedSpecialist(input,context,requiresBusinessGrounding?'no_evidence':prepared?.route,prepared?.answer));
    if(output.mode==='live')mode='live';
    groundingRejected ||= Boolean(output.groundingRejected);
    const usedIds=new Set(output.evidenceIds??(!prepared&&!scopedInsight?knowledge.map(item=>item.id):[]));
    const usedSentences=outputSentences(output.answer).map(normalizedClaim);
    const referencesUsed=[...(!checkRecords?knowledge:[]).map(item=>({
      id:item.id,title:item.title,
      excerpt:(outputSentences(item.content).find(sentence=>usedSentences.includes(normalizedClaim(sentence)))??item.content).slice(0,240),
    })),
      ...(scopedInsight&&(insightKind==='profile'||publicCompanyEvidence)?companyCitations(deal):[]),
      ...(scopedInsight&&expansionProfile?companyCitations(deal,expansionProfile):[]),
      ...recordEvidence.map(item=>({id:item.id,title:item.source,excerpt:item.value.slice(0,240)}))];
    for(const item of referencesUsed)if(usedIds.has(item.id)&&!citations.some(entry=>entry.id===item.id))citations.push(item);
    usedAgents.push(agentId);answers.push(output.answer);
    const references=revision?'按当前要求改写上一轮输出':checkRecords?`引用 ${usedIds.size} 条本轮资料`:scopedInsight&&insightKind==='demand'?'核对当前项目中的客户需求记录与相关知识库证据':scopedInsight?'基于当前项目与相关企业资料分析':`引用${usedIds.size}条生效资料`;
    const generationStatus=output.groundingRejected?`已调用模型，${output.mode==='live'?'已保留通过资料核对的内容':'已展示本轮可核对资料及核验状态'}`:output.mode==='demo'?'本地规则演示，未请求外部模型':'服务端外部模型返回';
    step(`${agentName(agentId)}生成`,`${generationStatus}${output.modelName?`（${output.modelName}）`:''}；${references}${deal?`；客户：${deal.name}`:''}${instruction?`；节点指令：${instruction}`:''}`, output.groundingRejected?'warning':'success',agentId,Date.now()-tick,generationPhase,
      output.groundingRejected?'保留了通过资料核对的内容。':'本轮答复已生成。');
  };
    const shouldEnrich=deal&&(deal.dataOrigin==='manual'||deal.dataOrigin==='research')&&
      (refreshProfile||!deal.companyProfile?.sources.length&&(profileAndDemand||insightKind==='profile'&&deal.dataOrigin==='manual'));
    if(insightGenerator&&deal&&shouldEnrich) {
      const tick=Date.now();
      const previousProfile=deal.companyProfile;
      const profilePhase=startPhase('检索企业公开资料','正在读取企业公开资料。','insight');
      try {
        const profile=await enrichDeal(deal,context);
        const preserve=!!previousProfile?.sources.length&&(!profile.facts.length||!profile.sources.length||profile.provider==='web');
        if(!preserve){deal.companyProfile=profile;deal.version++;}
        const provider=profile.provider==='qcc'?'企查查接口':profile.provider==='jinghai'?'鲸海数据接口':'公开网络检索';
        step('检索企业公开资料',`${provider}；取得 ${profile.sources.length} 个来源、${profile.facts.length} 项资料。${preserve?'保留已保存的画像。':''}${profile.warnings.join('；')}`,preserve||profile.status==='partial'?'warning':'success','insight',Date.now()-tick,profilePhase,
          `本轮取得 ${profile.sources.length} 个公开来源。`);
      }catch {
        step('检索企业公开资料',`企业资料补全暂时未完成。${previousProfile?.sources.length?'保留已保存的画像。':'本轮使用项目中的现有资料。'}`,'warning','insight',Date.now()-tick,profilePhase,'企业公开资料暂未读取完成。');
      }
    }
    const prepareKnowledge=needsSharedKnowledge?context.prepareKnowledge:undefined;
    if(prepareKnowledge)knowledgePhase??=beginKnowledge();
    const prepared=prepareKnowledge&&knowledgePhase?await knowledgePhase.wait(()=>prepareKnowledge({
      audience:'workspace',question:query,retrievalQuery,
      ...((checkRecords||demandQuestion)&&deal?{subject:deal.name,intent:'business' as const}:{}),
      ...(checkRecords?{subjectKind:'records' as const,retrievalQuery:recordQuery}:{}),
      ...(propertyContinuation&&latest?.propertyQuery?{propertyQuery:latest.propertyQuery}:{}),
      history:history.map(item=>({role:'user' as const,content:item.query})),
    })):undefined;
    const searchExpansion=demandQuestion&&!!deal&&(deal.dataOrigin==='manual'||deal.dataOrigin==='research')&&
      /搜|查|调研|核实/.test(query)&&/扩张|扩店|拓店|新店|开店|选址|扩租|租房|租赁|承租|续租|租(?:铺|商铺|门面|场地)/.test(query)&&
      !/(?:仅|只)(?:用|查|看|检索)(?:现有|当前|本项目|内部|知识库)|(?:不要|不用|别|无需)(?:联网|上网|搜公开|查公开)/.test(query);
    if(searchExpansion&&context.searchCompanyExpansion&&prepared){
      const warning=prepared.route==='failed'||prepared.route==='conflict'||prepared.recordLookup?.complete===false;
      knowledgePhase?.finish(warning?'warning':'success',prepared.route==='failed'?'授权资料暂未读取完成。':
        prepared.route==='conflict'?'相关资料存在冲突。':prepared.route==='direct'?'本轮无需引用知识库资料。':'已核对本轮的授权资料。');
    }
    if(searchExpansion&&deal&&context.searchCompanyExpansion){
      const tick=Date.now();
      const expansionPhase=startPhase('检索公开经营场地线索','正在检索公开的经营场地线索。','insight');
      try{
        expansionProfile=await context.searchCompanyExpansion({name:deal.name});
        publicSearchStatus=expansionProfile.sources.length?'公开搜索摘要仅供跟进核实。':'本轮公开检索未找到能归属该企业的相关选址、扩张或租赁线索。';
        step('检索公开经营场地线索',`找到 ${expansionProfile.sources.length} 条相关公开摘要。`,'success','insight',Date.now()-tick,expansionPhase,
          `找到 ${expansionProfile.sources.length} 条相关公开摘要。`);
      }catch{
        publicSearchStatus='本轮公开检索暂时未完成。';
        step('检索公开经营场地线索',publicSearchStatus,'warning','insight',Date.now()-tick,expansionPhase,'公开检索暂未完成。');
      }
    }
    if(deal&&(profileAndDemand||expansionProfile?.sources.length)){
      publicCompanyEvidence=[
        ...(profileAndDemand?customerInsightEvidence(deal).filter(item=>item.sourceIds?.length):[]),
        ...(expansionProfile?.sources??[]).flatMap(source=>source.snippet?.trim()?[{
          id:source.id,label:'经营场地线索（公开搜索摘要，待核实）',value:source.snippet,source:source.title,sourceIds:[source.id],
        }]:[]),
      ];
    }
    if(!checkRecords&&prepared?.recordLookup?.kind==='property'&&prepared.answer?.trim()) {
      citations.length=0;
      const evidenceIds=new Set(prepared.evidenceIds);
      for(const item of prepared.knowledge)if(evidenceIds.has(item.id)&&!citations.some(entry=>entry.id===item.id))citations.push({id:item.id,title:item.title,excerpt:item.content.slice(0,240)});
      step('按条件筛选知识库房源',`在已授权的房源资料中匹配面积、业态、位置等条件；${prepared.recordLookup.complete?'本次资料范围已扫描完成':'部分资料尚未完整读取，结果范围已在回答中说明'}；找到 ${prepared.recordLookup.total} 条匹配记录。`,prepared.recordLookup.complete?'success':'warning',undefined,0,knowledgePhase);
      return {id:uid('run'),query,answer:prepared.answer,agentIds:[routed[0]],steps,citations,mode:'demo',answerSource:'property-records',...(prepared.recordLookup.query?{propertyQuery:structuredClone(prepared.recordLookup.query)}:{}),createdAt:now,duration:Date.now()-started,...(deal?{dealId:deal.id}:{})};
    }
    if(prepared){
      knowledge=[...(prepared.route==='retrieved'?prepared.knowledge.map(asKnowledge):[]),...tracks.map(talkKnowledge)];
    }else if(needsSharedKnowledge){
      const scopedQuery=checkRecords&&deal?`${deal.name}\n${recordQuery}`:retrievalQuery;
      const retrieveManagedKnowledge=context.retrieveManagedKnowledge;
      knowledgePhase??=beginKnowledge();
      const managed = retrieveManagedKnowledge?await knowledgePhase.wait(()=>retrieveManagedKnowledge(scopedQuery)):[];
      knowledge = [...managed, ...tracks.map(talkKnowledge), ...retrieveKnowledge(state,scopedQuery)];
    }else knowledgePhase?.finish('success','已核对本轮的授权资料。');
    if(checkRecords&&deal){
      const companyOnly=/(?:只|仅)(?:查|看|算|考虑)(?:总公司|公司本级|公司本身)|(?:不要|别|不)(?:查|看|算|包括|包含)(?:门店|分公司|分支机构|关联主体)/.test(query);
      recordEvidence=knowledge.flatMap(item=>{
        const record=companyRecordEvidencePassage(deal.name,recordQuery,item.title,item.content);
        return record&&(!companyOnly||record.scope==='company')?[{id:item.id,source:item.title,value:record.excerpt,sourceIds:[item.id],
          label:`知识库记录（${record.scope==='company'?'公司本级':'门店或关联主体'}）`}]:[];
      });
      knowledge=knowledge.filter(item=>recordEvidence.some(record=>record.id===item.id));
      const libraryStatus=prepared?.route==='failed'?'知识库检索暂时未完成。':prepared?.route==='conflict'?'知识库相关资料存在冲突，未据此作结论。':`授权知识库匹配 ${recordEvidence.length} 条相关记录。`;
      step('检索生效知识',libraryStatus,prepared?.route==='failed'||prepared?.route==='conflict'?'warning':'success',undefined,0,knowledgePhase,libraryStatus);
      const useExternal=(deal.dataOrigin==='manual'||deal.dataOrigin==='research')&&
        !/(?:仅|只)(?:限|在|用|查|看|检索|参考|使用|根据|依据)(?:现有|已有|当前|本项目|内部|知识库)|(?:不要|不用|别|无需|不必|禁止)(?:用|做|使用)?(?:联网|上网|网络|搜公开|查公开|外部|查外部|搜索公开)/.test(query);
      const tick=Date.now();
      const publicPhase=useExternal&&(context.searchCompanyRecords||context.searchCompanyPenalties)?
        startPhase('检索企业公开记录','正在核对企业公开记录。','insight'):undefined;
      const [publicResult,penalties]=useExternal?await Promise.all([
        context.searchCompanyRecords?.({name:deal.name},recordQuery).catch(()=>undefined),
        context.searchCompanyPenalties?.({name:deal.name},recordQuery).catch(()=>undefined),
      ]):[];
      const publicRecords=(publicResult?.sources??[]).filter(source=>!companyOnly||source.scope==='company');
      if(penalties?.status==='records')recordEvidence.push(...penalties.records.slice(0,4).map(record=>({id:record.id,
        value:[record.subject,record.decisionDate,record.authority,record.decisionNo,record.excerpt].filter(Boolean).join(' · '),source:penalties.source.title,
        url:penalties.source.url,sourceIds:[record.id],label:'鲸海数据行政处罚记录（公司本级）'})));
      recordEvidence.push(...publicRecords.map(source=>({id:source.id,value:source.excerpt,source:source.title,url:source.url,sourceIds:[source.id],
        label:`公开搜索摘要（${source.scope==='company'?'公司本级':'门店或关联主体'}，待核实）`})));
      const provider=publicResult?.provider==='deepseek'?'DeepSeek 联网搜索':publicResult?.provider==='bing'?'公开网页搜索':'';
      const publicStatus=!useExternal||!context.searchCompanyRecords?'本轮未进行公开检索。':!publicResult||publicResult.status==='failed'?'本轮公开检索暂时未完成。':
        `本轮公开检索${publicResult.status==='partial'?'部分完成，':''}匹配 ${publicRecords.length} 条相关摘要${provider?`（${provider}）`:''}。`;
      const penaltyStatus=penalties?.status==='records'?`鲸海数据返回 ${penalties.records.length} 条可匹配公司本级的行政处罚记录。`:penalties?.status==='empty'?
        '鲸海数据本次未返回匹配的行政处罚记录。':penalties?.status==='unverified'?'鲸海数据返回内容暂不能核对为当前公司的行政处罚记录。':
        penalties?.status==='unavailable'?'鲸海数据行政处罚查询暂未完成。':'';
      if(useExternal&&(context.searchCompanyRecords||penalties))step('检索企业公开记录',`${penaltyStatus}${publicStatus}未直连官方记录库。`,publicResult?.status==='completed'||penalties?.status==='records'?'success':'warning','insight',Date.now()-tick,publicPhase,`${penaltyStatus}${publicStatus}`);
      else publicPhase?.finish('skipped','本轮没有可用的外部记录渠道。');
      recordStatus=`${libraryStatus}${penaltyStatus}${publicStatus}本轮未直连官方记录库。`;
    }
    if(needsSharedKnowledge&&!checkRecords){
      const detail=prepared?.route==='direct'?'本轮问题可直接由模型回答。'
        :prepared?.route==='failed'?'知识库暂时无法读取。'
        :prepared?.route==='conflict'?'找到适用范围一致但内容冲突的资料。'
        :`筛选出${knowledge.length}条与本轮问题相关的资料。`;
      step('检索生效知识',detail,prepared?.route==='failed'||prepared?.route==='conflict'?'warning':'success',undefined,0,knowledgePhase,detail);
    }
    const responder=routed.at(-1)!;
    const perspectives=routed.slice(0,-1).map(agentName);
    await generate(responder,missingRecordSubject?'本轮没有定位到可查询的客户主体。请用户提供企业全称或选定要查的项目，不推断其违规或处罚情况。':missingDemandSubject?'本轮没有选定客户或项目。请用户提供要调研的客户或项目名称。':
      perspectives.length?`同时考虑${perspectives.join('、')}视角，组织成一份完整回答。`:undefined);
    const boundaryPhase=startPhase('核对建议边界','正在确认答复的资料边界。');
    step('核对建议边界','保留待核实事项；健康度为规则分值；未自动承诺商务条件或修改商机。','success',undefined,0,boundaryPhase,'已标注需要核实的事项。');
  return {id:uid('run'),query,answer:answers.join('\n\n────────\n\n'),agentIds:[...new Set(usedAgents)],steps,citations,mode,...(mode==='demo'&&groundingRejected?{answerSource:'evidence-boundary' as const}:{}),createdAt:now,duration:Date.now()-started,...(deal?{dealId:deal.id}:{})};
}

const clip=(value:string,max=3000)=>value.length>max?`${value.slice(0,max)}\n（内容较长，已截取）`:value;
const byteSize=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const own=<T>(record:Record<string,T>,id:string):T|undefined=>Object.hasOwn(record,id)?record[id]:undefined;
const mergeIds=(items:string[][])=>[...new Set(items.flat())];
const frameAnswer=(checkpoint:WorkflowCheckpoint,frame:WorkflowFrame,max=18000)=>clip(frame.answerIds.map(id=>own(checkpoint.answers,id)??'').filter(Boolean).join('\n\n────────\n\n'),max);
function validateKnowledgeSelections(state:WorkbenchState,workflow:Workflow) {
  const available=new Set(publishedKnowledge(state).map(item=>item.id));
  for(const node of workflow.nodes.filter(node=>node.type==='knowledge'))if(node.knowledgeIds?.some(id=>!available.has(id)))fail(`“${node.label}”包含不存在或尚未发布的知识，请重新选择`);
}
function compactDeal(deal:Deal):Deal {
  return {...deal,notes:deal.notes.filter(note=>!note.recording?.sourceOnly).slice(0,5).map(note=>({...note,text:clip(note.text,1000)}))};
}
/** A checkpoint contains references to shared outputs rather than nested copies of upstream text. */
async function executeWorkflow(state:StoredState,run:Run,checkpoint:WorkflowCheckpoint,context:ActionContext):Promise<void> {
  const started=Date.now();const {workflow}=checkpoint;
  const trace=(node:FlowNode,detail:string,input:string,output:string,status:TraceStep['status']='success',duration=0)=>run.steps.push({id:uid('step'),nodeId:node.id,title:`${({start:'开始',intent:'意图',knowledge:'知识',agent:'专家',review:'人工确认',output:'输出'} as const)[node.type]} · ${node.label}`,detail:clip(detail,1000),input:clip(input,1500),output:clip(output,2500),status,duration,...(node.type==='agent'?{agent:node.agentId}:{})});
  run.status='completed';delete run.awaitingNodeId;
  for(;checkpoint.cursor<checkpoint.order.length;checkpoint.cursor++) {
    const node=workflow.nodes.find(item=>item.id===checkpoint.order[checkpoint.cursor])!;
    const incoming=workflow.edges.filter(edge=>edge.to===node.id).flatMap(edge=>{const frame=own(checkpoint.frames,edge.from);return frame&&(!frame.targets||frame.targets.includes(node.id))?[frame]:[];});
    if(node.type!=='start'&&!incoming.length){trace(node,'当前输入未进入此分支。','','','skipped');continue;}
    const inheritedRoute=(['conflict','failed','no_evidence','retrieved','direct'] as const).find(route=>incoming.some(item=>item.knowledgeRoute===route));
    const frame:WorkflowFrame={knowledgeIds:mergeIds(incoming.map(item=>item.knowledgeIds)),answerIds:mergeIds(incoming.map(item=>item.answerIds)),...(inheritedRoute?{knowledgeRoute:inheritedRoute}:{})};
    const previous=frameAnswer(checkpoint,frame,12000);const input=JSON.stringify({query:run.query,previous,knowledgeIds:frame.knowledgeIds,...(node.instruction?{instruction:node.instruction}:{})});
    const tick=Date.now();
    try {
      if(node.type==='start')trace(node,'读取本次输入与发起人的授权客户范围。',run.query,run.query);
      if(node.type==='intent') {
        const routes=workflow.edges.filter(edge=>edge.from===node.id);const intent=workflowIntent(run.query);
        if(routes.some(edge=>edge.condition!==undefined)) {
          const selected=routes.find(edge=>edge.condition===intent)??routes.find(edge=>edge.condition==='default')!;
          frame.targets=[selected.to];trace(node,`关键词分流为${agentName(intent)}，仅执行选中路径。`,input,`分支：${selected.condition==='default'?'默认':agentName(selected.condition! as AgentId)} → ${workflow.nodes.find(item=>item.id===selected.to)!.label}`);
        } else trace(node,'按关键词分流；当前节点未配置条件分支，沿已有连线继续。',input,`关键词分流：${agentName(intent)}`);
      }
      if(node.type==='knowledge') {
        const available=publishedKnowledge(state);const selected=node.knowledgeIds;
        if(selected?.some(id=>!available.some(item=>item.id===id)))fail('所选知识不存在或尚未发布，请重新选择生效资料');
        const candidates=selected===undefined?available:available.filter(item=>selected.includes(item.id));
        const ranked=rankedKnowledge(candidates,run.query);
        // Explicit bindings remain available even when the current query has no keyword match.
        const scoped=[...ranked,...candidates.filter(item=>!ranked.includes(item))].slice(0,4);
        const prepared=await context.prepareKnowledge?.({question:run.query,intent:'business'},selected===undefined?undefined:{knowledgeIds:selected,knowledge:scoped});
        if(prepared)frame.knowledgeRoute=(['conflict','failed','no_evidence','retrieved','direct'] as const).find(route=>route===prepared.route||route===frame.knowledgeRoute);
        const entries = prepared
          ? (prepared.route==='retrieved'?prepared.knowledge.filter(item=>selected===undefined||selected.includes(item.id)).map(asKnowledge):[])
          : selected === undefined
            ? [...await context.retrieveManagedKnowledge?.(run.query) ?? [], ...ranked].slice(0, 6)
            : scoped;
        for(const entry of entries) {
          checkpoint.knowledge[entry.id]={...entry,content:clip(entry.content,6000)};
          if(!run.citations.some(item=>item.id===entry.id))run.citations.push({id:entry.id,title:entry.title,excerpt:entry.content.slice(0,240)});
        }
        frame.knowledgeIds=mergeIds([frame.knowledgeIds,entries.map(item=>item.id)]);
        trace(node,prepared?`${knowledgeBoundary(prepared.route)} 检索到${entries.length}条生效资料。`:`检索到${entries.length}条生效资料；候选和退回 Skill 不参与检索。`,input,entries.map(item=>`${item.id} · ${item.title}`).join('\n')||'未检索资料');
      }
      if(node.type==='agent') {
        const knowledge=frame.knowledgeIds.map(id=>own(checkpoint.knowledge,id)).filter((item):item is Knowledge=>!!item);
        const generation:GenerationInput={salesScope:context.salesScope,query:run.query,agentId:node.agentId!,deal:checkpoint.deal,deals:checkpoint.deals,knowledge,instruction:node.instruction,previous,purpose:'workflow'};
        const output=await boundedSpecialist(generation,context,frame.knowledgeRoute);
        if(typeof output.answer!=='string'||!output.answer.trim())fail('专家未返回有效文本，请检查模型连接后重试',502);
        checkpoint.answers[node.id]=`${agentName(node.agentId!)}\n${clip(output.answer.trim(),6000)}`;
        frame.answerIds=mergeIds([frame.answerIds,[node.id]]);if(!run.agentIds.includes(node.agentId!))run.agentIds.push(node.agentId!);if(output.mode==='live')run.mode='live';
        trace(node,`${output.groundingRejected?'已调用模型，回复未通过资料核对':output.mode==='live'?'服务端模型生成':'本地规则演示，未请求外部模型'}；使用${knowledge.length}条生效资料。`,input,checkpoint.answers[node.id],'success',Date.now()-tick);
      }
      if(node.type==='review') {
        checkpoint.frames[node.id]=frame;checkpoint.cursor++;
        const checkpoints={...(state._workflowRuns??{}),[run.id]:checkpoint};
        if(byteSize(checkpoints)>512*1024)fail('待审核运行内容过多，请先处理现有审核后重试');
        state._workflowRuns=checkpoints;run.status='paused';run.awaitingNodeId=node.id;
        run.answer=[previous,'工作流已暂停，等待销售管理者人工确认。确认只控制此任务继续，不会批准商务条件或发布 Skill。'].filter(Boolean).join('\n\n');
        trace(node,'已暂停；后续节点将在管理者明确确认后继续。',input,'等待销售管理者确认','warning');run.duration+=Date.now()-started;return;
      }
      if(node.type==='output')trace(node,'汇总实际到达此输出节点的上游专家结果。',previous,previous||'当前路径未配置专家输出。');
      checkpoint.frames[node.id]=frame;
    } catch(error) {
      const detail=error instanceof DomainError?clip(error.message,500):'此节点执行失败，请检查模型连接或节点配置后重试';
      trace(node,detail,input,detail,'error',Date.now()-tick);run.status='failed';run.answer=detail;delete run.awaitingNodeId;delete state._workflowRuns?.[run.id];run.duration+=Date.now()-started;return;
    }
  }
  const outputFrames=workflow.nodes.filter(node=>node.type==='output').map(node=>own(checkpoint.frames,node.id)).filter((item):item is WorkflowFrame=>!!item);
  run.answer=frameAnswer(checkpoint,{knowledgeIds:[],answerIds:mergeIds(outputFrames.map(frame=>frame.answerIds))})||'工作流已完成；当前路径未配置专家生成节点。';
  delete state._workflowRuns?.[run.id];run.duration+=Date.now()-started;
}
async function startWorkflow(state:StoredState,role:Role,workflow:Workflow,source:'draft'|'published',query:string,context:ActionContext,now:string,dealId?:unknown):Promise<Run> {
  const order=validateWorkflow(workflow,true);const deal=chooseDeal(state,role,query,dealId);
  const active=state.deals.filter(item=>!item.archive);const scoped=role==='sales'?active.filter(item=>item.ownerId===scopeFor(state).salesId):active;
  const checkpoint:WorkflowCheckpoint={workflow:structuredClone({...workflow,published:undefined}),role,deal:deal?compactDeal(deal):undefined,deals:scoped.map(compactDeal),order,cursor:0,knowledge:{},answers:{},frames:{}};
  const run:Run={id:uid('run'),query,answer:'',agentIds:[],steps:[],citations:deal?companyCitations(deal):[],mode:'demo',createdAt:now,duration:0,workflowId:workflow.id,workflowVersion:workflow.version,workflowSource:source,status:'completed',...(deal?{dealId:deal.id}:{})};
  await executeWorkflow(state,run,checkpoint,context);return run;
}
/** Bound persisted traces/checkpoints independently of the number of generated nodes. */
function trimRunHistory(state:StoredState) {
  state.runs=state.runs.slice(0,100);
  while(state.runs.length>1&&byteSize(state.runs)>768*1024)state.runs.pop();
  if(state._workflowRuns)for(const id of Object.keys(state._workflowRuns))if(!state.runs.some(run=>run.id===id))delete state._workflowRuns[id];
}

async function trainingResponse(input:TrainingGenerationInput,context:ActionContext):Promise<TrainingGenerationOutput> {
  const generated=context.trainingGenerate?await context.trainingGenerate({ ...structuredClone(input), messages: input.messages.map(({role,content}) => ({role,content})) }):demoTrainingGenerate(input);
  if(!generated||typeof generated.answer!=='string'||!generated.answer.trim()||generated.answer.length>2000||!['live','demo'].includes(generated.mode))fail('客户回复格式或长度异常，请重试',502);
  const suggestion = typeof generated.replySuggestion === 'string' ? generated.replySuggestion.trim() : '';
  return {...generated,answer:generated.answer.trim(),replySuggestion:suggestion.length <= 240 && suggestion ? suggestion : undefined};
}

/** Returns an unfiltered canonical state; only projectState may be sent to a client. */
async function executeActionInternal(original:WorkbenchState,role:Role,action:string,payload:Record<string,unknown>,context:ActionContext={}):Promise<ApiResult> {
  const state=structuredClone(original) as StoredState;bindScope(state,context.salesScope,context.salesOwners);const now=context.now??new Date().toISOString();const actor=context.actorName===undefined?(role==='sales'?scopeFor(state).displayName:'周予安'):text(context.actorName,'操作者姓名',200);
  if(managerActions.has(action)&&role!=='manager')fail('此操作需要销售管理者体验视角',403);
  if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('请求参数格式不正确');
  let run:Run|undefined;let session:TrainingSession|undefined;let dealId:string|undefined;let message='已保存';
  if(action==='deal_intake'){
    onlyFields(payload,new Set(['requestId','text','inputMode','forceNew']));
    const requestId=text(payload.requestId,'录入标识',36);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))fail('录入标识无效');
    text(payload.text,'客户描述',6000);const rawText=payload.text as string;if(payload.inputMode!=='text'&&payload.inputMode!=='speech')fail('请选择文字或语音录入');
    if(payload.forceNew!==undefined&&typeof payload.forceNew!=='boolean')fail('请确认是否另建项目');
    if(state.deals.some(d=>d.notes.some(n=>n.intakeRequestId===requestId)))fail('该条录入已记入跟进，请开始新的录入',409);
    const replay=state.deals.find(d=>d.intake?.requestId===requestId);
    if(replay){visibleDeal(state,role,replay.id);if(replay.intake?.rawText!==rawText||replay.intake.inputMode!==payload.inputMode)fail('该录入已提交，请重新开始一条录入',409);return {state,dealId:replay.id,message:'该客户记录已保存'};}
    if(!context.extractIntake)fail('请先在设置中配置并启用大模型 API，再使用智能录入',503);
    let extracted:IntakeExtraction;try{extracted=validateIntakeExtraction(await context.extractIntake(rawText),rawText);}catch(error){if(error instanceof DomainError)throw error;fail('客户描述未能可靠识别，请补充企业名称与需求后重试',502);}
    if(extracted.status==='needs_info')return {state,intake:{status:'needs_info',question:extracted.question||'请补充客户企业名称。',draft:extracted},message:'请补充必要信息'};
    const normalize=(v:string)=>v.toLowerCase().replace(/[\s·・,，。;；:：()（）]/g,'');
    const name=text(extracted.fields.name,'企业名称',200),projectName=text(extracted.fields.projectName||`${name} · 新商机`,'项目名称',200);
    const matches=state.deals.filter(d=>!d.archive&&d.dataOrigin==='manual'&&(role!=='sales'||d.ownerId===scopeFor(state).salesId)&&normalize(d.name)===normalize(name)&&(projectName===`${name} · 新商机`||normalize(d.projectName||d.name)===normalize(projectName)));
    if(matches.length&&payload.forceNew!==true)return {state,intake:{status:'duplicate',question:'已有相似项目，要记为跟进，还是另建项目？',draft:extracted,existing:matches.slice(0,5).map(d=>({id:d.id,name:d.name,projectName:d.projectName||d.name}))},message:'找到已有项目，请选择录入方式'};
    const fields={...extracted.fields};delete fields.stage;
    if(fields.website){try{fields.website=publicUrl(/^https?:\/\//i.test(fields.website)?fields.website:`https://${fields.website}`);}catch{delete fields.website;}}
    const owner=assignedOwner(state,role,undefined,actor);
    const deal:Deal={id:uid('deal'),name,projectName,contact:'',position:'',industry:'',...owner,stage:'线索',amount:0,health:0,priority:'medium',lastContact:now.slice(0,10),nextAction:'',summary:'',needs:[],risks:[],notes:[{id:uid('note'),text:rawText,author:actor,date:now}],version:1,avatar:Array.from(name)[0],createdAt:now,dataOrigin:'manual',...projectChanges(fields),intake:{requestId,rawText,inputMode:payload.inputMode,capturedAt:now}};
    state.deals.unshift(deal);state.revision++;activity(state,role,'客户已智能录入',`${projectName} · 已保留沟通原话`,'deal',now);return {state,dealId:deal.id,message:'客户已录入，正在更新洞察与预测'};
  }
  const contractStarted=Date.now();
  const contractResult=await handleContractAction(state,role,action,payload,{now,actorName:actor,review:context.reviewContract,modelName:context.contractModelName});
  if(contractResult){
    const document=contractResult.reviewed;
    if(document?.analysis){const a=document.analysis;const high=a.findings.filter(f=>f.level==='high').length;run={id:uid('run'),query:`合同初审：${document.title}`,answer:[`## ${document.title} · 合同初审`,a.summary,`审查范围：${a.coverage.characters}字，${a.coverage.clauses}个原文片段，${a.coverage.chunks}批。`,...a.findings.map((f,i)=>`### ${i+1}. ${f.title}（${{high:'高',medium:'中',low:'低'}[f.level]}风险）\n\n原文：${f.quote}\n\n风险原因：${f.reason}\n\n修改意见：${f.suggestion}\n\n建议文本：${f.replacement}`),...(a.missingItems.length?['### 待补充事项',...a.missingItems.map(m=>`- ${m.title}：${m.reason}；${m.suggestion}`)]:[]),...a.warnings].join('\n\n'),agentIds:['risk'],mode:'live',createdAt:now,dealId:document.dealId,status:'completed',duration:Date.now()-contractStarted,steps:[{id:uid('step'),title:'读取合同原文',detail:`已保存的项目合同 · v${document.version-1} · ${a.coverage.characters}字`,status:'success',agent:'risk',duration:0},{id:uid('step'),title:'商务风控 Agent 初审',detail:`完整提交${a.coverage.clauses}个片段、${a.coverage.chunks}批，发现${high}项高风险条款；原文锚点经服务端核验。`,status:'success',agent:'risk',duration:0}],citations:a.findings.map(f=>({id:`${document.id}-${f.id}`,title:f.title,excerpt:f.quote}))};state.runs.unshift(run);mark(state,run.id,role);}
    trimRunHistory(state);state.revision++;activity(state,role,'合同初审与处理',contractResult.message,'contract',now);return {state,contractId:contractResult.id,message:contractResult.message,...(run?{run}:{})};
  }
  const talkMessage=await handleTalkAction(state,role,action,payload,now,context.approveTalkTrack,actor);
  if(talkMessage){state.revision++;activity(state,role,'实战话术与项目信息已更新',talkMessage,'talktrack',now);return {state,message:talkMessage};}
  switch(action) {
    case 'deal_intake_followup': {
      onlyFields(payload,new Set(['dealId','requestId','text','inputMode']));const deal=visibleDeal(state,role,payload.dealId);
      const requestId=text(payload.requestId,'录入标识',36);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))fail('录入标识无效');
      text(payload.text,'跟进原话',6000);const rawText=payload.text as string;if(payload.inputMode!=='text'&&payload.inputMode!=='speech')fail('请选择文字或语音录入');
      if(state.deals.some(d=>d.intake?.requestId===requestId||d.id!==deal.id&&d.notes.some(n=>n.intakeRequestId===requestId)))fail('该条录入已保存到其他记录，请开始新的跟进',409);
      const saved=deal.notes.find(n=>n.intakeRequestId===requestId);if(saved){if(saved.text!==rawText||saved.inputMode!==payload.inputMode)fail('该条录入已保存，请开始新的跟进',409);return {state,dealId:deal.id,message:'该条跟进已保存'};}
      deal.notes.unshift({id:uid('note'),text:rawText,author:actor,date:now,intakeRequestId:requestId,inputMode:payload.inputMode});deal.version++;deal.lastContact=now.slice(0,10);dealId=deal.id;activity(state,role,`${deal.name}新增跟进`,rawText.slice(0,100),'deal',now);message='沟通原话已记入项目跟进';break;
    }
    case 'deal_assess': {const deal=visibleDeal(state,role,payload.dealId);onlyFields(payload,new Set(['dealId','version']));checkVersion(deal.version,payload.version);dealId=deal.id;message='项目已提交重新评估';break;}
    case 'deal_create': {
      onlyFields(payload,new Set([...projectFields,'ownerId']));
      const name=text(payload.name,'企业名称',200);const projectName=text(payload.projectName,'项目名称',200);
      const owner=assignedOwner(state,role,payload.ownerId,actor);
      const deal:Deal={id:uid('deal'),name,projectName,contact:'',position:'',industry:'',...owner,stage:'线索',amount:0,health:0,priority:'medium',lastContact:'',nextAction:'',summary:'',needs:[],risks:[],notes:[],version:1,avatar:Array.from(name)[0],createdAt:now,dataOrigin:'manual',...projectChanges(payload)};
      state.deals.unshift(deal);dealId=deal.id;
      activity(state,role,'项目已创建',`${projectName} · ${name}`,'deal',now);message='项目已创建';break;
    }
    case 'deal_update': {
      const deal=visibleDeal(state,role,payload.dealId);checkVersion(deal.version,payload.version);
      onlyFields(payload,new Set([...projectFields,'dealId','version']));
      const changes=projectChanges(payload,deal);if(!Object.keys(changes).length)fail('请填写需要更新的项目信息');
      if(changes.name!==undefined&&changes.name!==deal.name)delete deal.companyProfile;
      Object.assign(deal,changes);deal.version++;dealId=deal.id;
      activity(state,role,'项目信息已更新',`${deal.projectName??deal.name} · ${actor}`,'deal',now);break;
    }
    case 'deal_enrich': {
      const deal=visibleDeal(state,role,payload.dealId);checkVersion(deal.version,payload.version);
      onlyFields(payload,new Set(['dealId','version']));const started=Date.now();
      const profile=await enrichDeal(deal,context);
      if(deal.companyProfile?.sources.length&&!profile.sources.length)fail('本次检索未取得有效来源，已保留原企业画像，请稍后重试',503);
      deal.companyProfile=profile;deal.version++;dealId=deal.id;
      run={id:uid('run'),query:`补全${deal.name}的企业画像`,answer:companyAnswer(profile),agentIds:['insight'],steps:[{id:uid('step'),title:'客户洞察 · 企业资料补全',detail:`${profile.provider==='qcc'?'企查查接口':profile.provider==='jinghai'?'鲸海数据接口':'公开网络检索'}；取得${profile.sources.length}个来源、${profile.facts.length}项有来源资料。${profile.warnings.length?` ${profile.warnings.join('；')}`:''}`,status:profile.status==='partial'?'warning':'success',agent:'insight',duration:Date.now()-started}],citations:companyCitations(deal),mode:profile.modelUsed?'live':'demo',createdAt:now,duration:Date.now()-started,dealId:deal.id,status:'completed'};
      state.runs.unshift(run);mark(state,run.id,role);activity(state,role,'企业画像已更新',`${deal.name} · ${profile.status==='partial'?'部分资料待核实':`${profile.sources.length}个来源`}`,'deal',now);message=profile.status==='partial'?'企业画像已保存，部分资料待核实':'企业画像已补全';break;
    }
    case 'deal_note': {
      const deal=visibleDeal(state,role,payload.dealId);
      if(Object.prototype.hasOwnProperty.call(payload,'recording'))fail('请通过录音上传入口添加附件');
      const recording=context.trustedRecording;
      const value=recording?optional(payload.text,5000):text(payload.text,'跟进备注',6000);
      deal.notes.unshift({id:uid('note'),text:value,author:actor,date:now,...(recording?{recording:{...recording}}:{})});if(recording?.sourceOnly){message='原录音已保存';break;}
      deal.version++;deal.lastContact=now.slice(0,10);
      activity(state,role,`${deal.name}新增跟进`,value.slice(0,100)||(recording?`上传录音：${recording.name}`:''),'deal',now);break;
    }
    case 'recording_apply': {
      const review=context.trustedRecordingProcessing;
      if(!review||payload.confirmed!==true||payload.draftId!==review.draftId)fail('请先核对并确认录音整理草稿',403);
      if(review.sourceDealId!==RECORDING_INBOX_DEAL_ID){
        const source=visibleDeal(state,role,review.sourceDealId);
        if(!source.notes.some(note=>note.recording?.id===review.recordingId))fail('原录音已不存在',404);
      }
      const deal=visibleDeal(state,role,review.dealId);
      if(deal.archive)fail('归档项目不可写入跟进和画像',409);
      checkVersion(deal.version,review.version);
      if(Object.keys(review.profile).length)deal.customerProfile=customerProfile(review.profile,deal.customerProfile);
      if(review.followup){
        deal.notes.unshift({id:uid('note'),text:review.followup,author:actor,date:now,recordingProcessingId:review.draftId});
        deal.lastContact=now.slice(0,10);
      }
      deal.version++;dealId=deal.id;
      activity(state,role,'录音整理已确认',`${deal.projectName??deal.name} · ${actor}`,'deal',now);
      message='已将确认内容写入项目';break;
    }
    case 'deal_stage': {
      const deal=visibleDeal(state,role,payload.dealId);checkVersion(deal.version,payload.version);
      if(payload.confirmed!==true)fail('请确认客户事实后再更新阶段');
      if(!STAGES.includes(payload.stage as typeof STAGES[number]))fail('商机阶段不正确');
      const previous=deal.stage;deal.stage=payload.stage as string;deal.version++;
      activity(state,role,`${deal.name}阶段更新`,`${actor}手动确认：${previous} → ${deal.stage}。`,'deal',now);break;
    }
    case 'skill_candidate': {
      const deal=payload.dealId?visibleDeal(state,role,payload.dealId):undefined;
      const skill:Skill={id:uid('skill'),title:optional(payload.title,200)||`${deal?.name??'招商'}实战经验待审`,category:'销售经验',status:'candidate',author:actor,description:optional(payload.description,5000)||'从合成示例任务整理的方法草稿，需管理者核对证据、适用条件和授权边界。',scenario:optional(payload.scenario,3000)||`适用于${deal?.industry??'园区招商'}客户沟通；具体事实需再次核实。`,steps:list(payload.steps,['确认客户需求与关键事实','记录执行动作和客户反馈','整理可复用步骤并核对证据','提交销售管理者人工审核']),boundaries:list(payload.boundaries,['不得承诺未经审批的优惠或交付条件','示例经验不代表真实业绩，发布前核对依据']),evidence:optional(payload.evidence,5000)||'当前仅有合成示例依据；待管理者审核补充。',source:optional(payload.source,3000)||`${deal?.name??'手工'}示例复盘`,version:1,updatedAt:now};
      state.skills.unshift(skill);mark(state,skill.id,role);activity(state,role,'已提交候选 Skill',`${skill.title}等待管理者人工审核，尚未进入知识检索。`,'skill',now);message='已生成候选 Skill，等待销售管理者审核';break;
    }
    case 'skill_review': {
      const skill=find(state.skills,payload.skillId,'Skill');checkVersion(skill.version,payload.version);if(skill.status!=='candidate')fail('此Skill已审核，请刷新列表',409);
      if(payload.decision!=='publish'&&payload.decision!=='reject')fail('审核结果不正确');
      const note=text(payload.note,'审核说明',3000);skill.status=payload.decision==='publish'?'published':'rejected';skill.reviewer=actor;skill.reviewNote=note;skill.version++;skill.updatedAt=now;
      if(skill.status==='published')state.knowledge.unshift({id:`knowledge-${skill.id}`,title:skill.title,category:skill.category,content:[skill.description,`适用场景：${skill.scenario}`,`步骤：${skill.steps.join('；')}`,`边界：${skill.boundaries.join('；')}`,`依据：${skill.evidence}`].join('\n\n'),source:`${actor}人工审核的Skill v${skill.version}`,status:'published',updatedAt:now});
      activity(state,role,`Skill${skill.status==='published'?'已生效':'已退回'}`,`${skill.title} · ${actor}：${note}`,'skill',now);message=skill.status==='published'?'Skill已审核生效，可供检索引用':'Skill已退回，未进入知识检索';break;
    }
    case 'knowledge_add': {
      const item:Knowledge={id:uid('knowledge'),title:text(payload.title,'资料标题',200),content:text(payload.content,'资料内容',50000),category:optional(payload.category,80)||'导入资料',source:`${actor}手动导入`,status:'published',updatedAt:now};
      state.knowledge.unshift(item);activity(state,role,'知识资料已导入',`${item.title} · ${actor}`,'knowledge',now);break;
    }
    case 'workflow_save': {
      const workflow=sanitizeWorkflow(payload.workflow,now);const previous=state.workflows.find(item=>item.id===workflow.id);
      if(previous){checkVersion(previous.version,workflow.version);workflow.version=previous.version+1;const saved=publication(previous);if(saved){workflow.published=saved;workflow.status='published';}state.workflows[state.workflows.findIndex(item=>item.id===workflow.id)]=workflow;}else {workflow.version=1;state.workflows.unshift(workflow);}
      activity(state,role,'应用草稿已保存',`${workflow.name} · v${workflow.version}，线上版本在重新发布前继续生效。`,'workflow',now);message='草稿已保存；发布后团队才会使用此版本';break;
    }
    case 'workflow_publish': {
      const workflow=find(state.workflows,payload.workflowId,'工作流');checkVersion(workflow.version,payload.version);const existing=publication(workflow);if(existing&&existing.version===workflow.version)fail('此版本已经发布，请修改并保存新草稿后再发布',409);validateWorkflow(workflow,true);validateKnowledgeSelections(state,workflow);workflow.status='published';workflow.version++;workflow.updatedAt=now;
      workflow.published={name:workflow.name,description:workflow.description,...(workflow.kind?{kind:workflow.kind}:{}),nodes:structuredClone(workflow.nodes),edges:structuredClone(workflow.edges),version:workflow.version,publishedAt:now};
      activity(state,role,'应用已发布',`${workflow.name} · v${workflow.version}`,'workflow',now);message='已发布，销售视角现在可以使用此版本';break;
    }
    case 'chat': {
      const query=text(payload.query,'问题',6000);run=await buildRun(state,role,query,context,now,{agentId:payload.agentId,dealId:payload.dealId,conversationRunIds:payload.conversationRunIds,talkTrackIds:payload.talkTrackIds});state.runs.unshift(run);for(const trackId of [...new Set(run.citations.filter(c=>state.talkTracks?.some(t=>t.id===c.id)).map(c=>c.id))]){(state.talkTrackUsages??=[]).unshift({trackId,runId:run.id,dealId:run.dealId,usedAt:now});}mark(state,run.id,role);activity(state,role,'专家协作已完成',`${run.agentIds.map(agentName).join('、')} · ${run.answerSource==='property-records'?'知识库房源筛选':run.answerSource==='evidence-boundary'?'已调用模型 · 资料校验':run.mode==='demo'?'演示生成':'外部模型生成'}`,'run',now);message=run.answerSource==='property-records'?'已完成知识库房源筛选':run.answerSource==='evidence-boundary'?'已调用模型，已展示核对结果':run.mode==='demo'?'已完成演示生成，未调用外部模型':'已完成服务端模型生成';break;
    }
    case 'workflow_run': {
      if(payload.mode!==undefined&&payload.mode!=='draft'&&payload.mode!=='published')fail('运行模式不正确');
      if(role==='sales'&&(payload.mode==='draft'||payload.workflow!==undefined))fail('销售体验视角只能运行管理者发布的应用',403);
      const source=role==='sales'||payload.mode==='published'?'published':'draft';
      const workflow=source==='draft'&&payload.workflow!==undefined?sanitizeWorkflow(payload.workflow,now):find(state.workflows,payload.workflowId,'工作流');
      const executable=source==='published'?publishedView(workflow):workflow;const query=text(payload.query,'工作流输入',6000);
      run=await startWorkflow(state,role,executable,source,query,context,now,payload.dealId);state.runs.unshift(run);mark(state,run.id,role);
      activity(state,role,source==='draft'?'应用调试已记录':'应用运行已记录',`${executable.name} · ${run.status==='paused'?'等待人工确认':run.status==='failed'?'执行失败':'执行完成'}`,'workflow',now);message=run.status==='paused'?'工作流已暂停，等待人工确认':run.status==='failed'?'节点执行失败，已保存调试轨迹':'工作流运行完成';break;
    }
    case 'workflow_review': {
      run=find(state.runs,payload.runId,'运行');const checkpoint=state._workflowRuns?.[run.id];
      if(run.status!=='paused'||!checkpoint||!run.awaitingNodeId)fail('此运行已处理或不在等待人工确认，请刷新后查看',409);
      if(payload.decision!=='approve'&&payload.decision!=='reject')fail('请选择确认继续或拒绝');
      const note=text(payload.note,'审核说明',1000);run.review={reviewer:actor,decision:payload.decision,note,date:now};
      const step=run.steps.find(item=>item.nodeId===run!.awaitingNodeId&&item.status==='warning');
      if(step){step.status=payload.decision==='approve'?'success':'error';step.detail=`${actor}${payload.decision==='approve'?'确认继续':'拒绝继续'}：${note}`;step.output=step.detail;}
      if(payload.decision==='reject'){run.status='rejected';delete run.awaitingNodeId;delete state._workflowRuns![run.id];run.answer=`本次运行已由${actor}拒绝继续：${note}`;message='已拒绝，后续节点未执行';}
      else {await executeWorkflow(state,run,checkpoint,context);message=run.status==='paused'?'已继续执行，等待下一项人工确认':run.status==='failed'?'后续节点执行失败，已保存轨迹':'已确认并继续完成任务';}
      activity(state,role,'应用运行已审核',`${run.query.slice(0,100)} · ${note}`,'workflow',now);break;
    }
    case 'training_start': {
      if(payload.confirmed!==true)fail('请先确认客户画像后再开始训练');
      const scenario=text(payload.scenario,'训练场景',1000);
      let profile;try {profile=validateTrainingProfile(payload.profile);}catch(error){fail(error instanceof TypeError?error.message:'客户画像格式不正确');}
      const opening=await trainingResponse({scenario,profile,messages:[]},context);
      session={id:uid('training'),scenario,profile,mode:opening.mode,customer:`${profile.name} · ${profile.role}`,messages:[{role:'assistant',content:opening.answer,...(opening.replySuggestion ? { replySuggestion:opening.replySuggestion } : {})}],status:'active',createdAt:now};
      state.trainingSessions.unshift(session);mark(state,session.id,role);message=opening.mode==='live'?'客户对练已开始':'演示对练已开始';break;
    }
    case 'training_reply': {
      session=find(state.trainingSessions,payload.sessionId,'训练');owned(state,session.id,role);if(session.status!=='active')fail('本次训练已经结束，请开始新的训练',409);
      const voiceTurnId=payload.voiceTurnId===undefined?undefined:text(payload.voiceTurnId,'语音轮次标识',128);
      if(voiceTurnId&&session.voiceTurnIds?.includes(voiceTurnId)){message='此轮语音已保存';break;}
      if(session.messages.length>=41)fail('本次训练已达到20轮，请结束并查看反馈');
      const answer=text(payload.text,'练习回答',4000);
      const profile=session.profile??defaultTrainingProfile(session.scenario);
      const messages:TrainingSession['messages']=[...session.messages,{role:'user',content:answer}];
      const response=await trainingResponse({scenario:session.scenario,profile,messages},context);
      session.mode=response.mode;session.messages=[...messages,{role:'assistant',content:response.answer,...(response.replySuggestion ? { replySuggestion:response.replySuggestion } : {})}];
      if(voiceTurnId)session.voiceTurnIds=[...(session.voiceTurnIds??[]),voiceTurnId];message='客户已回应';break;
    }
    case 'training_finish': {
      session=find(state.trainingSessions,payload.sessionId,'训练');owned(state,session.id,role);if(session.status!=='active')fail('本次训练已经结束',409);
      const review=await evaluateTraining(session,context.trainingEvaluate);
      Object.assign(session,review,{status:'completed'});
      const scoring=review.evaluationMode==='live'?'AI 评价':'规则评价';
      activity(state,role,'带练复盘已生成',`${session.scenario} · ${scoring} ${review.score}/100。`,'training',now);
      message='带练复盘已保存';break;
    }
    default:fail('不支持的操作');
  }
  trimRunHistory(state);state.revision=original.revision+1;
  return {state,...(run?{run}:{}),...(session?{session}:{}),...(dealId?{dealId}:{}),message};
}

/** Record eligibility only from a successful human mutation; persistence shares the workspace CAS. */
export async function executeAction(original:WorkbenchState,role:Role,action:string,payload:Record<string,unknown>,context:ActionContext={}):Promise<ApiResult> {
  const result=await executeActionInternal(original,role,action,payload,context);
  markSalesBusinessChanges(original,result.state,context.now??new Date().toISOString());
  return result;
}
