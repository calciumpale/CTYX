import { AGENTS, STAGES } from './types.ts';
import type { AgentId, ApiResult, Deal, FlowNode, FollowupRecording, Knowledge, Role, Run, Skill, TraceStep, TrainingSession, WorkbenchState, Workflow } from './types.ts';

export class DomainError extends Error {
  status:number;
  constructor(message:string,status=400) { super(message); this.name='DomainError'; this.status=status; }
}
/** Internal visibility metadata stays in D1 and is stripped from API projections. */
type StoredState=WorkbenchState & {_access?:Record<string,string>};
export interface GenerationInput {query:string;agentId:AgentId;deal?:Deal;deals:Deal[];knowledge:Knowledge[];instruction?:string;previous?:string;}
export interface GenerationOutput {answer:string;mode:'demo'|'live';}
export interface ActionContext {now?:string;generate?:(input:GenerationInput)=>Promise<GenerationOutput>;trustedRecording?:FollowupRecording;}
const agentIds=new Set(AGENTS.map(item=>item.id));
const nodeTypes=new Set(['start','intent','knowledge','agent','review','output']);
const managerActions=new Set(['skill_review','knowledge_add','workflow_save','workflow_publish']);
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
  if(role==='sales'&&deal.ownerId!=='sales-1') fail('当前销售体验视角无权访问该客户',403);
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
    result.deals=result.deals.filter(item=>item.ownerId==='sales-1');
    result.workflows=result.workflows.filter(item=>item.status==='published');
    result.skills=result.skills.filter(item=>item.status==='published'||ownerOf(result,item.id)==='sales-1'||(!result._access?.[item.id]&&item.author==='林晓'));
    result.knowledge=result.knowledge.filter(item=>item.status==='published');
    result.runs=result.runs.filter(item=>ownerOf(result,item.id)==='sales-1');
    result.trainingSessions=result.trainingSessions.filter(item=>ownerOf(result,item.id)==='sales-1');
    result.activities=result.activities.filter(item=>ownerOf(result,item.id)==='sales-1'||item.id==='activity-1');
  }
  result.role=role;
  result.viewer={name:role==='sales'?'林晓':'周予安',team:'云栖园区 · 招商团队（体验空间）',salesId:'sales-1'};
  delete result._access;
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
    if(!nodeTypes.has(node.type)) fail('只允许开始、意图、知识、专家、人工审核和输出节点');
    if(nodeMap.has(node.id)) fail('节点编号不能重复');
    if(!Number.isFinite(node.x)||!Number.isFinite(node.y)) fail('节点位置必须为有效数值');
    if(node.agentId!==undefined&&!agentIds.has(node.agentId)) fail('请选择五位领域专家之一');
    if(complete&&node.type==='agent'&&!node.agentId) fail(`请为“${node.label}”选择专家`);
    optional(node.instruction,3000);nodeMap.set(node.id,node);
  }
  const edgeKeys=new Set<string>();
  for(const edge of workflow.edges) {
    if(!edge||typeof edge!=='object'||!nodeMap.has(edge.from)||!nodeMap.has(edge.to)) fail('连接引用了不存在的节点');
    const key=`${edge.from}\0${edge.to}`;if(edgeKeys.has(key)) fail('连接不能重复');edgeKeys.add(key);
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
  const workflow:Workflow={id:optional(input.id,100)||uid('workflow'),name:text(input.name,'工作流名称',100),description:optional(input.description,2000),status:'draft',version:input.version,updatedAt:now,nodes:input.nodes.map(node=>({id:node.id,type:node.type,label:node.label,x:node.x,y:node.y,...(node.agentId?{agentId:node.agentId}:{}),...(node.instruction?{instruction:node.instruction}:{})})),edges:input.edges.map(edge=>({from:edge.from,to:edge.to}))};
  validateWorkflow(workflow);return workflow;
}
export function routeAgents(query:string):AgentId[] {
  if(/培训|练习|带练|扮演|陪练/.test(query))return ['coach'];
  if(/风险|合同|免租|审批|合规|资质|违约|授权/.test(query))return /方案|谈判|回应|话术/.test(query)?['risk','strategy']:['risk'];
  if(/优先|预测|健康|本周|商机|漏斗|推进/.test(query))return ['opportunity'];
  if(/拜访|方案|策略|开场|话术|谈判/.test(query))return ['insight','strategy'];
  return ['insight'];
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
  const terms=new Set(query.match(/[\p{Script=Han}]{2}|[A-Za-z0-9]{2,}/gu)??[]);
  return publishedKnowledge(state).map(item=>({item,score:(query.includes(item.title)?100:0)+[...terms].filter(term=>`${item.title}${item.content}`.includes(term)).length})).sort((a,b)=>b.score-a.score).slice(0,4).map(item=>item.item);
}
function chooseDeal(state:WorkbenchState,role:Role,query:string,dealId?:unknown):Deal|undefined {
  if(role==='sales'&&state.deals.some(deal=>deal.ownerId!=='sales-1'&&query.includes(deal.name))) fail('当前销售体验视角无权访问问题中提及的客户',403);
  if(dealId) return visibleDeal(state,role,dealId);
  const matched=state.deals.find(deal=>query.includes(deal.name));
  return matched?visibleDeal(state,role,matched.id):undefined;
}
const agentName=(id:AgentId)=>AGENTS.find(item=>item.id===id)!.name;
export function demoGenerate(input:GenerationInput):GenerationOutput {
  const {agentId,deal,query,deals,knowledge,instruction}=input;
  const name=deal?.name??'当前商机';const facts=deal?`${name}目前处于${deal.stage}阶段，已记录的需求是${deal.needs.join('、')}。`:'以下只使用当前体验视角可见的合成示例资料。';
  let answer='';
  if(agentId==='insight') answer=`${facts}\n\n客户洞察：${deal?.summary??'先确认搬迁或拓店动因、空间用途、预算与交付时间，再与使用者及签约决策人核对优先条件。'}\n\n待核实的问题：${deal?`与${deal.contact}确认谁对预算和签约负责；${deal.risks.join('；')}。`:'谁提出需求、谁批准预算、谁有否决权？当前有哪些备选园区，最晚何时完成决策？'}\n\n建议下一步：${deal?.nextAction??'组织一次包含需求人与决策人的30分钟沟通，形成已确认事实和待核实事项清单。'}`;
  if(agentId==='strategy') answer=`${facts}\n\n拜访目标：将客户最关心的条件变成可核实的清单，争取约定一次具体的下一步。\n\n建议议程：前5分钟复述${deal?.needs[0]??'空间用途与核心需求'}，再用15分钟核对预算、交付和决策标准，最后10分钟比较两种授权内方案并确认责任人。\n\n开场可以说：“我先确认一下，${deal?.needs[0]??'交付时间和使用条件'}是否仍是这次选择的优先项？我们把尚未确认的条件列清，再决定如何推进。”\n\n跟进行动：${deal?.nextAction??'会后发送事实清单与两种可比较方案，并约定下次确认时间。'} 涉及优惠、交付保证或用途审批的条件须经正式审核。`;
  if(agentId==='risk') answer=`${facts}\n\n需要核对的商务风险：${deal?.risks.join('；')??(/免租/.test(query)?'免租诉求是否超出当前授权；装修周期与商业优惠是否混用；物业交付日期是否已书面确认。':'优惠授权、特殊用途资质、交付责任和付款条款是否有正式依据。')}\n\n处理建议：将诉求拆成“已确认事实、待核实条件、需要审批事项”，让对应负责人提供书面结论。${/免租/.test(query)?'示例政策只允许讨论30天内装修支持，60天免租不得直接承诺，须转经理审批。':''}\n\n对客户可以说：“我会把您的实际装修安排和总成本一起核算；超出授权的条件需要内部审批，我会给出明确的反馈时间。”\n\n本建议用于合成案例演示，不代替法务、物业或主管部门的专业确认。`;
  if(agentId==='opportunity') {
    const ranked=[...(deal?[deal]:deals)].sort((a,b)=>(a.priority==='high'?-1:1)-(b.priority==='high'?-1:1)||b.health-a.health).slice(0,3);
    answer=`建议优先核实以下商机的下一步：\n\n${ranked.map((item,index)=>`${index+1}. ${item.name}（${item.stage}，规则健康度${item.health}/100）：${item.nextAction}。依据：${item.summary} 风险缺口：${item.risks.join('；')}。`).join('\n\n')}\n\n这些分值来自合成示例规则，只用于提示信息完整度和跟进顺序，不是成交概率。客户确认预算、决策人和下一步后，再由销售手动确认是否推进阶段。`;
  }
  if(agentId==='coach') answer=`练习场景：${deal?.name??'园区招商客户'}提出商务条件异议。\n\n客户会说：“隔壁园区给的优惠更大，如果免租期谈不下来，我为什么要继续看这里？”\n\n建议先回应真实顾虑，再追问优惠背后的装修周期与总成本，比较授权内的空间、交付和服务价值，最后给出明确的下一步。不要承诺未审批条件。\n\n进入“培训带练”可以进行多轮客户对话；结束后按实际输入给出规则演示评分与证据。`;
  if(instruction) answer+=`\n\n本节点配置重点：${instruction}`;
  if(knowledge.length) answer+=`\n\n依据资料：${knowledge.map(item=>item.title).join('、')}。`;
  return {answer:`演示生成 · 未调用外部模型\n\n${answer}`,mode:'demo'};
}
async function buildRun(state:StoredState,role:Role,query:string,context:ActionContext,now:string,options:{agentId?:unknown;dealId?:unknown;workflow?:Workflow}={}):Promise<Run> {
  const started=Date.now();const steps:TraceStep[]=[];const citations:Run['citations']=[];const usedAgents:AgentId[]=[];let mode:Run['mode']='demo';let answers:string[]=[];
  const deal=chooseDeal(state,role,query,options.dealId);const visibleDeals=role==='sales'?state.deals.filter(item=>item.ownerId==='sales-1'):state.deals;
  let knowledge:Knowledge[]=[];
  const step=(title:string,detail:string,status:TraceStep['status']='success',agent?:AgentId,duration=0)=>steps.push({id:uid('step'),title,detail,status,agent,duration});
  const getKnowledge=()=> {knowledge=retrieve(state,query);for(const item of knowledge) if(!citations.some(entry=>entry.id===item.id))citations.push({id:item.id,title:item.title,excerpt:item.content.slice(0,240)});return knowledge;};
  const generate=async (agentId:AgentId,instruction?:string,previous=answers.join('\n\n'))=> {
    const tick=Date.now();const input:GenerationInput={query,agentId,deal,deals:visibleDeals,knowledge,instruction,previous};
    const output=context.generate?await context.generate(input):demoGenerate(input);
    if(output.mode==='live')mode='live';usedAgents.push(agentId);answers.push(`${agentName(agentId)}\n${output.answer}`);
    step(`${agentName(agentId)}生成`,`${output.mode==='demo'?'本地规则演示，未请求外部模型':'服务端外部模型返回'}；使用${knowledge.length}条生效资料${deal?`；客户：${deal.name}`:''}${instruction?`；节点指令：${instruction}`:''}`, 'success',agentId,Date.now()-tick);
    return `${agentName(agentId)}\n${output.answer}`;
  };
  if(options.workflow) {
    const workflow=options.workflow;const order=validateWorkflow(workflow,true);let paused=false;
    const frames=new Map<string,{knowledge:Knowledge[];answers:string[]}>();
    for(const id of order) {
      const node=workflow.nodes.find(item=>item.id===id)!;
      const incoming=workflow.edges.filter(edge=>edge.to===id).map(edge=>frames.get(edge.from)!).filter(Boolean);
      knowledge=[...new Map(incoming.flatMap(frame=>frame.knowledge).map(item=>[item.id,item])).values()];
      const upstreamAnswers=[...new Set(incoming.flatMap(frame=>frame.answers))];
      const frame={knowledge,answers:upstreamAnswers};
      if(node.type==='start')step(`开始 · ${node.label}`,'读取当前用户输入和授权客户范围。');
      if(node.type==='intent')step(`意图 · ${node.label}`,`建议专家：${routeAgents(query).map(agentName).join('、')}；按已保存图中的专家配置执行。`);
      if(node.type==='knowledge'){getKnowledge();frame.knowledge=knowledge;step(`知识 · ${node.label}`,`实际检索${knowledge.length}条已发布资料；候选及退回Skill未进入检索。`);}
      if(node.type==='agent')frame.answers=[...upstreamAnswers,await generate(node.agentId!,node.instruction,upstreamAnswers.join('\n\n'))];
      if(node.type==='review') {step(`人工确认 · ${node.label}`,'已暂停执行，未通过人工审核；后续节点未执行。','warning');answers.push('工作流已暂停，等待销售管理者人工确认。当前运行不会自动通过审核、发布Skill或修改商务条件。');paused=true;break;}
      if(node.type==='output')step(`输出 · ${node.label}`,'汇总已经执行的专家结果，完成当前工作流分支。');
      frames.set(id,frame);
    }
    if(!answers.length)answers=[paused?'等待人工确认。':'工作流已运行；当前图未配置专家生成节点，请在搭建中心补充后测试。'];
  } else {
    if(options.agentId!==undefined&&!agentIds.has(options.agentId as AgentId))fail('请选择五位领域专家之一');
    const routed=options.agentId?[options.agentId as AgentId]:routeAgents(query);
    step('主 Agent 识别意图',`${role==='manager'?'销售管理者':'销售'}主 Agent ${options.agentId?'按指定专家':'按问题关键词路由'}至${routed.map(agentName).join('、')}。`);
    getKnowledge();step('检索生效知识',`检索当前空间的${knowledge.length}条生效资料；未读取候选或退回Skill。`);
    for(const agentId of routed)await generate(agentId);
    step('核对建议边界','保留待核实事项；健康度为规则分值；未自动承诺商务条件或修改商机。');
  }
  return {id:uid('run'),query,answer:answers.join('\n\n────────\n\n'),agentIds:[...new Set(usedAgents)],steps,citations,mode,createdAt:now,duration:Date.now()-started,...(options.workflow?{workflowId:options.workflow.id}:{})};
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
function customerReply(session:TrainingSession,answer:string):string {
  const turns=session.messages.filter(item=>item.role==='user').length;
  if(/培训|演练/.test(session.scenario)&&turns>5)return '（演示客户）我们已聊了几个关键点，请帮我总结已确认条件、待核实事项和下一步安排。';
  if(/我保证|肯定能批|不用审批|直接给您/.test(answer))return '（演示客户）这个优惠您能直接决定吗？请把正式审批条件和书面确认时间说清楚。';
  if(/预算|成本|装修|开业/.test(answer)&&turns===1)return '（演示客户）我们预计两个月后开业，装修大约需要45天。预算比较紧，我担心交付延期还要承担租金，你们有什么可比较的方案？';
  if(/审批|授权/.test(answer))return '（演示客户）我理解需要审批。那您能在什么时间给我明确答复？在审批前，我们可以先核实哪些条件？';
  if(/明天|周|下午|时间|确认/.test(answer))return '（演示客户）可以，我希望下次看到具体的费用和交付清单。请说清谁来提供、哪些条件还需要确认。';
  return turns%2===0?'（演示客户）我还需要和合伙人比较总成本。除了价格，您说的交付与配套价值有什么依据？':'（演示客户）您先别急着给方案。我最担心的是装修和开业排期，您还需要了解哪些情况？';
}

/** Returns an unfiltered canonical state; only projectState may be sent to a client. */
export async function executeAction(original:WorkbenchState,role:Role,action:string,payload:Record<string,unknown>,context:ActionContext={}):Promise<ApiResult> {
  const state=structuredClone(original) as StoredState;const now=context.now??new Date().toISOString();const actor=role==='sales'?'林晓':'周予安';
  if(managerActions.has(action)&&role!=='manager')fail('此操作需要销售管理者体验视角',403);
  if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('请求参数格式不正确');
  let run:Run|undefined;let session:TrainingSession|undefined;let message='已保存';
  switch(action) {
    case 'deal_note': {
      const deal=visibleDeal(state,role,payload.dealId);
      if(Object.prototype.hasOwnProperty.call(payload,'recording'))fail('请通过录音上传入口添加附件');
      const recording=context.trustedRecording;
      const value=recording?optional(payload.text,5000):text(payload.text,'跟进备注',5000);
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
      if(previous){checkVersion(previous.version,workflow.version);workflow.version=previous.version+1;state.workflows[state.workflows.findIndex(item=>item.id===workflow.id)]=workflow;}else {workflow.version=1;state.workflows.unshift(workflow);}
      activity(state,role,'工作流草稿已保存',`${workflow.name} · v${workflow.version}，发布前需要通过结构验证。`,'workflow',now);message='草稿已保存；修改后需重新发布';break;
    }
    case 'workflow_publish': {
      const workflow=find(state.workflows,payload.workflowId,'工作流');checkVersion(workflow.version,payload.version);if(workflow.status==='published')fail('工作流已经发布',409);validateWorkflow(workflow,true);workflow.status='published';workflow.version++;workflow.updatedAt=now;activity(state,role,'工作流已发布',`${workflow.name} · v${workflow.version}`,'workflow',now);break;
    }
    case 'chat': {
      const query=text(payload.query,'问题',6000);run=await buildRun(state,role,query,context,now,{agentId:payload.agentId,dealId:payload.dealId});state.runs.unshift(run);mark(state,run.id,role);activity(state,role,'专家协作已完成',`${run.agentIds.map(agentName).join('、')} · ${run.mode==='demo'?'演示生成':'外部模型生成'}`,'run',now);message=run.mode==='demo'?'已完成演示生成，未调用外部模型':'已完成服务端模型生成';break;
    }
    case 'workflow_run': {
      const workflow=find(state.workflows,payload.workflowId,'工作流');if(role==='sales'&&workflow.status!=='published')fail('销售体验视角只能运行已发布工作流',403);
      const query=text(payload.query,'工作流输入',6000);run=await buildRun(state,role,query,context,now,{workflow});state.runs.unshift(run);mark(state,run.id,role);activity(state,role,'工作流测试已记录',`${workflow.name} · ${run.steps.some(step=>step.status==='warning')?'等待人工确认':'执行完成'}`,'workflow',now);message=run.steps.some(step=>step.status==='warning')?'工作流已暂停，等待人工确认':'工作流运行完成';break;
    }
    case 'training_start': {
      const scenario=text(payload.scenario,'训练场景',1000);session={id:uid('training'),scenario,customer:'园区招商客户 · 演示扮演',messages:[{role:'assistant',content:`（演示客户）${/决策|需求|首次|首访|拜访/.test(scenario)?'我们在考虑换办公地点，但团队对面积和交付时间还没达成一致。您想先了解什么？':/竞品|比较/.test(scenario)?'我们也在比较隔壁园区的报价，租金看起来比这里低。您能说清两边的费用和交付条件有什么区别吗？':'我对这里有兴趣，但别的园区给的条件更优惠。装修还需要时间，你们能直接给60天免租吗？'}`}],status:'active',createdAt:now};state.trainingSessions.unshift(session);mark(state,session.id,role);message='演示训练已开始，结束后按实际回答进行规则评分';break;
    }
    case 'training_reply': {
      session=find(state.trainingSessions,payload.sessionId,'训练');owned(state,session.id,role);if(session.status!=='active')fail('本次训练已经结束，请开始新的训练',409);
      const voiceTurnId=payload.voiceTurnId===undefined?undefined:text(payload.voiceTurnId,'语音轮次标识',128);
      if(voiceTurnId&&session.voiceTurnIds?.includes(voiceTurnId)){message='此轮语音已保存';break;}
      if(session.messages.length>=41)fail('本次训练已达到20轮，请结束并查看反馈');
      const answer=text(payload.text,'练习回答',4000);session.messages.push({role:'user',content:answer});session.messages.push({role:'assistant',content:customerReply(session,answer)});if(voiceTurnId)session.voiceTurnIds=[...(session.voiceTurnIds??[]),voiceTurnId];message='客户已回应';break;
    }
    case 'training_finish': {
      session=find(state.trainingSessions,payload.sessionId,'训练');owned(state,session.id,role);if(session.status!=='active')fail('本次训练已经结束',409);
      session.status='completed';session.feedback=trainingFeedback(session);session.score=session.feedback.reduce((total,item)=>total+item.score,0);activity(state,role,'培训复盘已生成',`${session.scenario} · 规则演示评分${session.score}/100；不代表真实能力或业绩预测。`,'training',now);message='规则演示复盘已保存';break;
    }
    default:fail('不支持的操作');
  }
  state.runs=state.runs.slice(0,100);state.revision=original.revision+1;
  return {state,...(run?{run}:{}),...(session?{session}:{}),message};
}
