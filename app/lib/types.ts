export type Role = 'sales' | 'manager';
export type View = 'home' | 'deals' | 'training' | 'knowledge' | 'studio' | 'runs' | 'settings';
export type AgentId = 'insight' | 'strategy' | 'opportunity' | 'risk' | 'coach';
export const AGENTS: {id: AgentId; name: string; description: string; starter: string}[] = [
  {id:'insight',name:'客户洞察',description:'读懂客户，找到沟通的切入点',starter:'帮我分析澄光咖啡的客户需求和关键决策人'},
  {id:'strategy',name:'策略方案',description:'把客户需求，变成可执行方案',starter:'为澄光咖啡准备一次拜访方案和开场话术'},
  {id:'opportunity',name:'商机预测',description:'找到值得推进的下一步',starter:'本周哪些商机最值得优先跟进？请说明依据'},
  {id:'risk',name:'商务风控',description:'核对商务条件，把握授权边界',starter:'检查澄光咖啡免租期诉求的商务风险'},
  {id:'coach',name:'培训带练',description:'在真实沟通之前，先练习一次',starter:'陪我练习客户提出免租期异议时如何回应'},
];
export const STAGES = ['线索','商机','方案','合同','回款'] as const;
export interface Deal {id:string; name:string; contact:string; position:string; industry:string; owner:string; ownerId:string; stage:string; amount:number; health:number; priority:'high'|'medium'|'low'; lastContact:string; nextAction:string; summary:string; needs:string[]; risks:string[]; notes:{id:string;text:string;author:string;date:string}[]; version:number; avatar:string;}
export interface Skill {id:string;title:string;category:string;status:'candidate'|'published'|'rejected';author:string;description:string;scenario:string;steps:string[];boundaries:string[];evidence:string;source:string;version:number;reviewer?:string;reviewNote?:string;updatedAt:string;}
export interface Knowledge {id:string;title:string;category:string;content:string;source:string;status:'published'|'draft';updatedAt:string;}
export type NodeType = 'start'|'intent'|'knowledge'|'agent'|'review'|'output';
export interface FlowNode {id:string;type:NodeType;label:string;x:number;y:number;agentId?:AgentId;instruction?:string;}
export interface Workflow {id:string;name:string;description:string;status:'draft'|'published';nodes:FlowNode[];edges:{from:string;to:string}[];version:number;updatedAt:string;}
export interface TraceStep {id:string;title:string;agent?:AgentId;detail:string;duration:number;status:'success'|'warning'|'error';}
export interface Run {id:string;query:string;answer:string;agentIds:AgentId[];steps:TraceStep[];citations:{id:string;title:string;excerpt:string}[];mode:'demo'|'live';createdAt:string;duration:number;workflowId?:string;}
export interface TrainingSession {id:string;scenario:string;customer:string;messages:{role:'user'|'assistant';content:string}[];status:'active'|'completed';score?:number;feedback?:{label:string;score:number;evidence:string;suggestion:string}[];createdAt:string;}
export interface Activity {id:string;title:string;detail:string;date:string;type:string;}
export interface WorkbenchState {revision:number;role:Role;viewer:{name:string;team:string;salesId:string};dataMode:'example';model:{connected:boolean;name:string};deals:Deal[];skills:Skill[];knowledge:Knowledge[];workflows:Workflow[];runs:Run[];trainingSessions:TrainingSession[];activities:Activity[];}
export interface ApiResult {state:WorkbenchState;run?:Run;session?:TrainingSession;message?:string;}
export type Mutate = (action:string,payload?:Record<string,unknown>) => Promise<ApiResult>;
export interface ViewProps {state:WorkbenchState;mutate:Mutate;notify:(message:string)=>void;onAsk:(query:string,agentId?:AgentId,dealId?:string)=>void;}
