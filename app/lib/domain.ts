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
import { demoTrainingGenerate } from './training-dialogue.ts';
import type { TrainingGenerationInput } from './training-dialogue.ts';

export class DomainError extends Error {
  status:number;
  constructor(message:string,status=400) { super(message); this.name='DomainError'; this.status=status; }
}
/** Internal visibility metadata stays in D1 and is stripped from API projections. */
interface WorkflowFrame {knowledgeIds:string[];answerIds:string[];targets?:string[];}
interface WorkflowCheckpoint {workflow:Workflow;role:Role;deal?:Deal;deals:Deal[];knowledge:Record<string,Knowledge>;answers:Record<string,string>;frames:Record<string,WorkflowFrame>;order:string[];cursor:number;}
type StoredState=WorkbenchState & {_access?:Record<string,string>;_workflowRuns?:Record<string,WorkflowCheckpoint>};
export interface GenerationInput {query:string;agentId:AgentId;projectApprovals?:ProjectApprovalContext[];deal?:Deal;deals:Deal[];knowledge:Knowledge[];instruction?:string;previous?:string;history?:{query:string;answer:string}[];contractReviews?:{title:string;reviewedAt?:string;analysis:ContractAnalysis}[];purpose?:'chat'|'workflow';}
export interface GenerationOutput {answer:string;mode:'demo'|'live';}
export interface ActionContext {extractIntake?:(text:string)=>Promise<IntakeExtraction>;now?:string;generate?:(input:GenerationInput)=>Promise<GenerationOutput>;trainingGenerate?:(input:TrainingGenerationInput)=>Promise<GenerationOutput>;enrichCompany?:(deal:Deal)=>Promise<CompanyProfile>;trustedRecording?:FollowupRecording;reviewContract?:(document:ContractDocument,deal:Deal)=>Promise<ContractAnalysis>;contractModelName?:string;approveTalkTrack?:(track:TalkTrack)=>Promise<void>;retrieveTalkTracks?:(query:string)=>Promise<TalkTrack[]>;}
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
function assignedOwner(state:WorkbenchState,role:Role,requested:unknown):{ownerId:string;owner:string} {
  if(role==='sales') {if(requested!==undefined)fail('销售只能创建自己负责的项目');return {ownerId:'sales-1',owner:'林晓'};}
  if(requested===undefined||requested==='manager')return {ownerId:'manager',owner:'周予安'};
  const id=text(requested,'负责人',100);const existing=state.deals.find(deal=>deal.ownerId===id);
  if(!existing)fail('请选择已有的项目负责人');
  return {ownerId:existing.ownerId,owner:existing.owner};
}
function profileTime(value:unknown):string {
  const date=text(value,'来源获取时间',40);if(!Number.isFinite(Date.parse(date)))fail('来源获取时间不正确');return date;
}
/** Validate again at the trusted service boundary; client payloads cannot create research facts. */
function validateCompanyProfile(value:unknown,deal:Deal):CompanyProfile {
  try {
    const input=object(value);if(!input)fail('企业画像格式不正确');
    const companyName=text(input.companyName,'企业名称',200);if(companyName!==deal.name.trim())fail('企业画像与当前企业不匹配');
    if(input.provider!=='qcc'&&input.provider!=='web')fail('企业画像来源不正确');
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
function companyCitations(deal:Deal):Run['citations'] {
  return deal.companyProfile?.sources.map(source=>({id:`company-${deal.id}-${source.id}`,title:source.title,excerpt:`${source.url}\n来源：${source.provider==='qcc'?'企查查':'公开网络'}；获取时间：${source.retrievedAt}`}))??[];
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
  if(role==='sales'&&deal.ownerId!=='sales-1') fail('当前销售视角无权访问该项目',403);
  return deal;
}
function checkVersion(actual:number,supplied:unknown) {if(!Number.isInteger(supplied)||actual!==supplied) fail('记录已更新，请刷新后重试',409);}
function ownerOf(state:StoredState,id:string):string {return state._access?.[id]??'manager';}
function owned(state:StoredState,id:string,role:Role) {
  if(role==='sales'&&ownerOf(state,id)!=='sales-1') fail('当前视角无权访问这条记录',403);
}
function mark(state:StoredState,id:string,role:Role) { (state._access??={})[id]=role==='sales'?'sales-1':'manager'; }
function activity(state:StoredState,role:Role,title:string,detail:string,type:string,now:string) {
  const entry={id:uid('activity'),title,detail,date:now,type};state.activities.unshift(entry);mark(state,entry.id,role);state.activities=state.activities.slice(0,150);
}
export function assertRevision(state:WorkbenchState,revision:unknown) {
  if(!Number.isInteger(revision)||revision!==state.revision) fail('工作空间已更新，请刷新后重试；本次操作未保存',409);
}
export function projectState(state:WorkbenchState,role:Role):WorkbenchState {
  const result=structuredClone(state) as StoredState;
  if(role==='sales') {
    const ownIds=new Set(result.deals.filter(d=>d.ownerId==='sales-1').map(d=>d.id));
    result.contracts=result.contracts?.filter(c=>ownIds.has(c.dealId));
    result.transcripts=result.transcripts?.filter(t=>ownIds.has(t.dealId));
    result.feedbackJobs=result.feedbackJobs?.filter(j=>ownIds.has(j.dealId));
    result.talkTracks=result.talkTracks?.filter(t=>t.status==='published'||ownIds.has(t.dealId));
    result.talkTrackUsages=result.talkTrackUsages?.filter(u=>!u.dealId||ownIds.has(u.dealId));
    result.deals=result.deals.filter(item=>item.ownerId==='sales-1');
    result.workflows=result.workflows.filter(item=>item.published||item.status==='published').map(publishedView);
    result.skills=result.skills.filter(item=>item.status==='published'||ownerOf(result,item.id)==='sales-1'||(!result._access?.[item.id]&&item.author==='林晓'));
    result.knowledge=result.knowledge.filter(item=>item.status==='published');
    result.runs=result.runs.filter(item=>ownerOf(result,item.id)==='sales-1');
    result.trainingSessions=result.trainingSessions.filter(item=>ownerOf(result,item.id)==='sales-1');
    result.activities=result.activities.filter(item=>ownerOf(result,item.id)==='sales-1'||item.id==='activity-1');
  }
  for(const job of result.feedbackJobs??[]){delete job.leaseToken;delete job.leaseUntil;}
  result.role=role;
  result.viewer={name:role==='sales'?'林晓':'周予安',team:'销售工作空间',salesId:'sales-1'};
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
function publishedKnowledge(state:WorkbenchState):Knowledge[] {
  const entries=state.knowledge.filter(item=>item.status==='published');
  for(const skill of state.skills.filter(item=>item.status==='published')) {
    if(entries.some(item=>item.id===`knowledge-${skill.id}`)) continue;
    entries.push({id:`knowledge-${skill.id}`,title:skill.title,category:skill.category,content:[skill.description,`适用：${skill.scenario}`,skill.steps.join('；'),`边界：${skill.boundaries.join('；')}`].join('\n'),status:'published',source:`已审核Skill · ${skill.reviewer??'销售管理者'}`,updatedAt:skill.updatedAt});
  }
  return entries;
}
function retrieve(state:WorkbenchState,query:string):Knowledge[] {
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
  if(role==='sales'&&state.deals.some(deal=>deal.ownerId!=='sales-1'&&(
    !!deal.projectName&&query.includes(deal.projectName)||query.includes(deal.name)&&!state.deals.some(own=>own.ownerId==='sales-1'&&own.name===deal.name)
  )))fail('当前销售视角无权访问问题中提及的项目',403);
  const matches=state.deals.filter(deal=>query.includes(deal.name)||!!deal.projectName&&query.includes(deal.projectName));
  const visible=role==='sales'?matches.filter(deal=>deal.ownerId==='sales-1'):matches;
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
function isFollowup(query:string):boolean {
  if(/^(?:请)?(?:换(?:一?个)?话题|新(?:的)?问题|另(?:外)?(?:一?个)?问题|另外问|重新开始)/.test(query))return false;
  return /他们|她们|它们|该客户|这个客户|这家|那家|对方|上面|上述|刚才|之前的|前面的/.test(query)
    || /^(?:请|麻烦|帮我)?(?:继续|接着|再(?:简短|短|详细|展开|补充|解释|改|写|整理|说明)|还有呢|[他她它](?:的|有|需|预|要|说|会|能|是|呢))/.test(query)
    || /^(?:那|那么|还有)(?:预算|需求|风险|时间|价格|租金|免租|合同|决策人|下一步|呢|？|\?)/.test(query);
}
export function demoGenerate(input:GenerationInput):GenerationOutput {
  const {agentId,deal,query,deals,knowledge,instruction}=input;
  if(input.purpose==='chat'&&!deal&&!deals.length&&!knowledge.length)return {answer:'本地生成 · 未调用外部模型\n\n当前尚未配置模型连接，无法生成此问题的完整回答。请在设置中配置模型，或选择项目并填写需求、预算和下一步沟通目标。',mode:'demo'};
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
async function buildRun(state:StoredState,role:Role,query:string,context:ActionContext,now:string,options:{agentId?:unknown;dealId?:unknown;conversationRunIds?:unknown;talkTrackIds?:unknown}={}):Promise<Run> {
  const started=Date.now();const steps:TraceStep[]=[];const citations:Run['citations']=[];const usedAgents:AgentId[]=[];let mode:Run['mode']='demo';const answers:string[]=[];
  const priorRuns=conversationRuns(state,role,options.conversationRunIds);const history=boundedConversation(priorRuns);const latest=priorRuns.at(-1);
  const directDeal=chooseDeal(state,role,query,options.dealId);const followup=!!latest&&!directDeal&&isFollowup(query);
  const deal=directDeal??(followup?chooseDeal(state,role,latest!.query,latest!.dealId):undefined);
  if(options.agentId!==undefined&&!agentIds.has(options.agentId as AgentId))fail('请选择五位领域专家之一');
  const explicitIntent=/培训|练习|带练|扮演|陪练|风险|合同|免租|审批|合规|资质|违约|授权|优先|预测|健康|本周|商机|漏斗|推进|拜访|方案|策略|开场|话术|谈判/.test(query);
  const inheritedRoute=followup&&!explicitIntent?latest!.agentIds.filter(id=>agentIds.has(id)):[];
  const routed=options.agentId?[options.agentId as AgentId]:inheritedRoute.length?inheritedRoute:routeAgents(query);
  const retrievalQuery=followup?`${latest!.query}\n${query}`:query;
  const portfolio=routed.includes('opportunity')&&/商机|漏斗|客户|团队|招商|销售|跟进/.test(retrievalQuery);
  const visibleDeals=role==='sales'?state.deals.filter(item=>item.ownerId==='sales-1'):state.deals;
  const scopedDeals=deal?[deal]:portfolio?visibleDeals:[];
  const explicitTracks=approvedTracks(state,options.talkTrackIds);
  const semanticTracks=context.retrieveTalkTracks&&!explicitTracks.length&&routed.includes('strategy')?await context.retrieveTalkTracks(retrievalQuery):[];
  const tracks=[...new Map([...explicitTracks,...semanticTracks].map(t=>[t.id,t])).values()].slice(0,5);
  let knowledge:Knowledge[]=[];
  const step=(title:string,detail:string,status:TraceStep['status']='success',agent?:AgentId,duration=0)=>steps.push({id:uid('step'),title,detail,status,agent,duration});
  const getKnowledge=()=> {knowledge=[...tracks.map(talkKnowledge),...retrieve(state,retrievalQuery)];for(const item of knowledge) if(!citations.some(entry=>entry.id===item.id))citations.push({id:item.id,title:item.title,excerpt:item.content.slice(0,240)});return knowledge;};
  const generate=async (agentId:AgentId,instruction?:string,previous=answers.join('\n\n'))=> {
    const tick=Date.now();const input:GenerationInput={query,agentId,deal,deals:scopedDeals,knowledge,instruction:[instruction,explicitTracks.length?'用户指定采用以下已审核话术的结构和表达方式：'+explicitTracks.map(t=>t.title).join('、')+'。根据当前客户资料改写占位符，不照搬来源项目事实。':undefined].filter(Boolean).join('\n'),previous,history,...(agentId==='risk'&&deal?{contractReviews:(state.contracts??[]).filter(c=>c.dealId===deal.id&&c.analysis).slice(0,5).map(c=>({title:c.title,reviewedAt:c.reviewedAt,analysis:c.analysis!}))}:{}),purpose:'chat'};
    const output=context.generate?await context.generate(input):demoGenerate(input);
    if(output.mode==='live')mode='live';usedAgents.push(agentId);answers.push(`${agentName(agentId)}\n${output.answer}`);
    step(`${agentName(agentId)}生成`,`${output.mode==='demo'?'本地规则演示，未请求外部模型':'服务端外部模型返回'}；使用${knowledge.length}条生效资料${deal?`；客户：${deal.name}`:''}${instruction?`；节点指令：${instruction}`:''}`, 'success',agentId,Date.now()-tick);
    return `${agentName(agentId)}\n${output.answer}`;
  };
    step('主 Agent 识别意图',`${role==='manager'?'销售管理者':'销售'}主 Agent ${options.agentId?'按指定专家':inheritedRoute.length?'沿用当前对话专家':'按问题关键词路由'}至${routed.map(agentName).join('、')}。`);
    if(deal?.dataOrigin==='manual'&&!deal.companyProfile?.sources.length&&routed.includes('insight')) {
      const tick=Date.now();
      try {
        deal.companyProfile=await enrichDeal(deal,context);deal.version++;
        step('检索企业公开资料',`${deal.companyProfile.provider==='qcc'?'企查查接口':'公开网络检索'}；取得${deal.companyProfile.sources.length}个来源。${deal.companyProfile.warnings.join('；')}`,deal.companyProfile.status==='partial'?'warning':'success','insight',Date.now()-tick);
      }catch {
        step('检索企业公开资料','企业资料补全暂时未完成，本次仅依据已填写的项目资料回答；未核验信息保持未知。','warning','insight',Date.now()-tick);
      }
    }
    if(deal)citations.push(...companyCitations(deal));
    getKnowledge();step('检索生效知识',`检索当前空间的${knowledge.length}条生效资料；未读取候选或退回Skill。`);
    for(const agentId of routed)await generate(agentId);
    step('核对建议边界','保留待核实事项；健康度为规则分值；未自动承诺商务条件或修改商机。');
  return {id:uid('run'),query,answer:answers.join('\n\n────────\n\n'),agentIds:[...new Set(usedAgents)],steps,citations,mode,createdAt:now,duration:Date.now()-started,...(deal?{dealId:deal.id}:{})};
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
  return {...deal,notes:deal.notes.slice(0,5).map(note=>({...note,text:clip(note.text,1000)}))};
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
    const frame:WorkflowFrame={knowledgeIds:mergeIds(incoming.map(item=>item.knowledgeIds)),answerIds:mergeIds(incoming.map(item=>item.answerIds))};
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
        const entries=selected===undefined?ranked:[...ranked,...candidates.filter(item=>!ranked.includes(item))].slice(0,4);
        for(const entry of entries) {
          checkpoint.knowledge[entry.id]={...entry,content:clip(entry.content,6000)};
          if(!run.citations.some(item=>item.id===entry.id))run.citations.push({id:entry.id,title:entry.title,excerpt:entry.content.slice(0,240)});
        }
        frame.knowledgeIds=mergeIds([frame.knowledgeIds,entries.map(item=>item.id)]);
        trace(node,`检索到${entries.length}条生效资料；候选和退回 Skill 不参与检索。`,input,entries.map(item=>`${item.id} · ${item.title}`).join('\n')||'未检索资料');
      }
      if(node.type==='agent') {
        const knowledge=frame.knowledgeIds.map(id=>own(checkpoint.knowledge,id)).filter((item):item is Knowledge=>!!item);
        const generation:GenerationInput={query:run.query,agentId:node.agentId!,deal:checkpoint.deal,deals:checkpoint.deals,knowledge,instruction:node.instruction,previous,purpose:'workflow'};
        const output=context.generate?await context.generate(generation):demoGenerate(generation);
        if(typeof output.answer!=='string'||!output.answer.trim())fail('专家未返回有效文本，请检查模型连接后重试',502);
        checkpoint.answers[node.id]=`${agentName(node.agentId!)}\n${clip(output.answer.trim(),6000)}`;
        frame.answerIds=mergeIds([frame.answerIds,[node.id]]);if(!run.agentIds.includes(node.agentId!))run.agentIds.push(node.agentId!);if(output.mode==='live')run.mode='live';
        trace(node,`${output.mode==='live'?'服务端模型生成':'本地规则演示，未请求外部模型'}；使用${knowledge.length}条生效资料。`,input,checkpoint.answers[node.id],'success',Date.now()-tick);
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
  const scoped=role==='sales'?state.deals.filter(item=>item.ownerId==='sales-1'):state.deals;
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

function trainingFeedback(session:TrainingSession):NonNullable<TrainingSession['feedback']> {
  const replies=session.messages.filter(item=>item.role==='user').map(item=>item.content);
  const rubric=[
    {label:'需求追问',patterns:[/为什么|原因|顾虑|担心/,/预算|成本|金额/,/时间|开业|装修|什么时候/,/需求|优先|比较|谁|决策/],suggestion:'用开放问题确认装修周期、预算与决策标准。'},
    {label:'共情倾听',patterns:[/理解|了解|明白/,/您|贵司/,/顾虑|担心|考虑|重视/,/确认|听起来|是否|对吗/],suggestion:'先复述客户最在意的条件，再给出回应。'},
    {label:'价值表达',patterns:[/总成本|整体|长期|比较/,/交付|装修|客流|配套|通勤|空间/,/方案|选择|对比|安排/,/依据|清单|数据|核算|书面/],suggestion:'比较整体成本和交付价值，并说明需要补充的依据。'},
    {label:'推进动作',patterns:[/明天|周|今天|下午|上午|日期|下次/,/确认|约|沟通|一起/,/整理|发送|提供|提交|清单/,/负责人|我会|我们|我来/],suggestion:'约定明确时间、责任人和可交付的下一步。'},
    {label:'合规边界',patterns:[/审批|审核|授权/,/需要|核实|核对|确认/,/政策|合同|条件|书面/,/不能|不得|不承诺|以.*为准|还需要/],suggestion:'明确未审批条件不可承诺，说明审批与书面反馈路径。'},
  ];
  return rubric.map(item=>{const matched=replies.find(reply=>item.patterns.some(pattern=>pattern.test(reply)));const joined=replies.join('\n');let score=item.patterns.filter(pattern=>pattern.test(joined)).length*5;if(item.label==='合规边界'&&/我保证|肯定能批|直接给您|不用审批/.test(joined))score=0;return {label:item.label,score,evidence:matched?`规则演示依据：“${matched.slice(0,160)}”${score===0?'；检测到越权保证表达。':''}`:'本次尚无符合该维度关键词的回答，规则无法确认。',suggestion:item.suggestion};});
}
async function trainingResponse(input:TrainingGenerationInput,context:ActionContext):Promise<GenerationOutput> {
  const generated=context.trainingGenerate?await context.trainingGenerate(structuredClone(input)):demoTrainingGenerate(input);
  if(!generated||typeof generated.answer!=='string'||!generated.answer.trim()||generated.answer.length>2000||!['live','demo'].includes(generated.mode))fail('客户回复格式或长度异常，请重试',502);
  return {...generated,answer:generated.answer.trim()};
}

/** Returns an unfiltered canonical state; only projectState may be sent to a client. */
export async function executeAction(original:WorkbenchState,role:Role,action:string,payload:Record<string,unknown>,context:ActionContext={}):Promise<ApiResult> {
  const state=structuredClone(original) as StoredState;const now=context.now??new Date().toISOString();const actor=role==='sales'?'林晓':'周予安';
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
    const matches=state.deals.filter(d=>d.dataOrigin==='manual'&&(role!=='sales'||d.ownerId==='sales-1')&&normalize(d.name)===normalize(name)&&(projectName===`${name} · 新商机`||normalize(d.projectName||d.name)===normalize(projectName)));
    if(matches.length&&payload.forceNew!==true)return {state,intake:{status:'duplicate',question:'已有相似项目，要记为跟进，还是另建项目？',draft:extracted,existing:matches.slice(0,5).map(d=>({id:d.id,name:d.name,projectName:d.projectName||d.name}))},message:'找到已有项目，请选择录入方式'};
    const fields={...extracted.fields};delete fields.stage;
    if(fields.website){try{fields.website=publicUrl(/^https?:\/\//i.test(fields.website)?fields.website:`https://${fields.website}`);}catch{delete fields.website;}}
    const owner=assignedOwner(state,role,undefined);
    const deal:Deal={id:uid('deal'),name,projectName,contact:'',position:'',industry:'',...owner,stage:'线索',amount:0,health:0,priority:'medium',lastContact:now.slice(0,10),nextAction:'',summary:'',needs:[],risks:[],notes:[{id:uid('note'),text:rawText,author:actor,date:now}],version:1,avatar:Array.from(name)[0],createdAt:now,dataOrigin:'manual',...projectChanges(fields),intake:{requestId,rawText,inputMode:payload.inputMode,capturedAt:now}};
    state.deals.unshift(deal);state.revision++;activity(state,role,'客户已智能录入',`${projectName} · 已保留沟通原话`,'deal',now);return {state,dealId:deal.id,message:'客户已录入，正在更新洞察与预测'};
  }
  const contractStarted=Date.now();
  const contractResult=await handleContractAction(state,role,action,payload,{now,review:context.reviewContract,modelName:context.contractModelName});
  if(contractResult){
    const document=contractResult.reviewed;
    if(document?.analysis){const a=document.analysis;const high=a.findings.filter(f=>f.level==='high').length;run={id:uid('run'),query:`合同初审：${document.title}`,answer:[`## ${document.title} · 合同初审`,a.summary,`审查范围：${a.coverage.characters}字，${a.coverage.clauses}个原文片段，${a.coverage.chunks}批。`,...a.findings.map((f,i)=>`### ${i+1}. ${f.title}（${{high:'高',medium:'中',low:'低'}[f.level]}风险）\n\n原文：${f.quote}\n\n风险原因：${f.reason}\n\n修改意见：${f.suggestion}\n\n建议文本：${f.replacement}`),...(a.missingItems.length?['### 待补充事项',...a.missingItems.map(m=>`- ${m.title}：${m.reason}；${m.suggestion}`)]:[]),...a.warnings].join('\n\n'),agentIds:['risk'],mode:'live',createdAt:now,dealId:document.dealId,status:'completed',duration:Date.now()-contractStarted,steps:[{id:uid('step'),title:'读取合同原文',detail:`已保存的项目合同 · v${document.version-1} · ${a.coverage.characters}字`,status:'success',agent:'risk',duration:0},{id:uid('step'),title:'商务风控 Agent 初审',detail:`完整提交${a.coverage.clauses}个片段、${a.coverage.chunks}批，发现${high}项高风险条款；原文锚点经服务端核验。`,status:'success',agent:'risk',duration:0}],citations:a.findings.map(f=>({id:`${document.id}-${f.id}`,title:f.title,excerpt:f.quote}))};state.runs.unshift(run);mark(state,run.id,role);}
    trimRunHistory(state);state.revision++;activity(state,role,'合同初审与处理',contractResult.message,'contract',now);return {state,contractId:contractResult.id,message:contractResult.message,...(run?{run}:{})};
  }
  const talkMessage=await handleTalkAction(state,role,action,payload,now,context.approveTalkTrack);
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
      const owner=assignedOwner(state,role,payload.ownerId);
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
      run={id:uid('run'),query:`补全${deal.name}的企业画像`,answer:companyAnswer(profile),agentIds:['insight'],steps:[{id:uid('step'),title:'客户洞察 · 企业资料补全',detail:`${profile.provider==='qcc'?'企查查接口':'公开网络检索'}；取得${profile.sources.length}个来源、${profile.facts.length}项有来源资料。${profile.warnings.length?` ${profile.warnings.join('；')}`:''}`,status:profile.status==='partial'?'warning':'success',agent:'insight',duration:Date.now()-started}],citations:companyCitations(deal),mode:profile.modelUsed?'live':'demo',createdAt:now,duration:Date.now()-started,dealId:deal.id,status:'completed'};
      state.runs.unshift(run);mark(state,run.id,role);activity(state,role,'企业画像已更新',`${deal.name} · ${profile.status==='partial'?'部分资料待核实':`${profile.sources.length}个来源`}`,'deal',now);message=profile.status==='partial'?'企业画像已保存，部分资料待核实':'企业画像已补全';break;
    }
    case 'deal_note': {
      const deal=visibleDeal(state,role,payload.dealId);
      if(Object.prototype.hasOwnProperty.call(payload,'recording'))fail('请通过录音上传入口添加附件');
      const recording=context.trustedRecording;
      const value=recording?optional(payload.text,5000):text(payload.text,'跟进备注',6000);
      deal.notes.unshift({id:uid('note'),text:value,author:actor,date:now,...(recording?{recording:{...recording}}:{})});deal.version++;deal.lastContact=now.slice(0,10);
      activity(state,role,`${deal.name}新增跟进`,value.slice(0,100)||(recording?`上传录音：${recording.name}`:''),'deal',now);break;
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
      state.knowledge.unshift(item);activity(state,role,'知识资料已导入',item.title,'knowledge',now);break;
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
      const query=text(payload.query,'问题',6000);run=await buildRun(state,role,query,context,now,{agentId:payload.agentId,dealId:payload.dealId,conversationRunIds:payload.conversationRunIds,talkTrackIds:payload.talkTrackIds});state.runs.unshift(run);for(const trackId of [...new Set(run.citations.filter(c=>state.talkTracks?.some(t=>t.id===c.id)).map(c=>c.id))]){(state.talkTrackUsages??=[]).unshift({trackId,runId:run.id,dealId:run.dealId,usedAt:now});}mark(state,run.id,role);activity(state,role,'专家协作已完成',`${run.agentIds.map(agentName).join('、')} · ${run.mode==='demo'?'演示生成':'外部模型生成'}`,'run',now);message=run.mode==='demo'?'已完成演示生成，未调用外部模型':'已完成服务端模型生成';break;
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
      session={id:uid('training'),scenario,profile,mode:opening.mode,customer:`${profile.name} · ${profile.role}`,messages:[{role:'assistant',content:opening.answer}],status:'active',createdAt:now};
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
      session.mode=response.mode;session.messages=[...messages,{role:'assistant',content:response.answer}];
      if(voiceTurnId)session.voiceTurnIds=[...(session.voiceTurnIds??[]),voiceTurnId];message='客户已回应';break;
    }
    case 'training_finish': {
      session=find(state.trainingSessions,payload.sessionId,'训练');owned(state,session.id,role);if(session.status!=='active')fail('本次训练已经结束',409);
      session.status='completed';session.feedback=trainingFeedback(session);session.score=session.feedback.reduce((total,item)=>total+item.score,0);activity(state,role,'培训复盘已生成',`${session.scenario} · 规则演示评分${session.score}/100；不代表真实能力或业绩预测。`,'training',now);message='规则演示复盘已保存';break;
    }
    default:fail('不支持的操作');
  }
  trimRunHistory(state);state.revision=original.revision+1;
  return {state,...(run?{run}:{}),...(session?{session}:{}),...(dealId?{dealId}:{}),message};
}
