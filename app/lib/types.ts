import type {SalesIntelligence} from './sales-intelligence-types.ts';
import type {IntakeExtraction} from './project-intake-types.ts';
import type { ContractDocument } from './contract-types.ts';
import type { CallTranscript, TalkTrack, FeedbackJob, TalkTrackUsage, TalkTrackPolicy } from './talktrack-types.ts';
import type { TrainingProfile } from './training-profile.ts';

export type Role = 'sales' | 'manager';
export type View = 'home' | 'deals' | 'schedule' | 'training' | 'knowledge' | 'talktracks' | 'contracts' | 'approvals' | 'reports' | 'studio' | 'runs' | 'settings' | 'members' | 'rules' | 'meetings' | 'prospecting';
export type AgentId = 'insight' | 'strategy' | 'opportunity' | 'risk' | 'coach';
export const AGENTS: {id: AgentId; name: string; description: string; starter: string}[] = [
  {id:'insight',name:'AI 客户洞察',description:'读懂客户，找到沟通的切入点',starter:'帮我梳理当前项目的客户需求和关键决策人'},
  {id:'strategy',name:'AI 策略方案',description:'把客户需求，变成可执行方案',starter:'为当前项目准备一次拜访方案和开场话术'},
  {id:'opportunity',name:'AI 商机预测',description:'找到值得推进的下一步',starter:'本周哪些商机最值得优先跟进？请说明依据'},
  {id:'risk',name:'AI 商务风控',description:'初审合同、标注风险条款并给出修改建议',starter:'帮我梳理当前项目的合同风险和需要修改的条款'},
  {id:'coach',name:'AI 销售陪练',description:'在真实沟通之前，先练习一次',starter:'陪我练习客户提出采购价格异议时如何回应'},
];
export const STAGES = ['线索','商机','方案','合同','回款'] as const;
export interface FollowupRecording {id:string;name:string;size:number;mimeType:string;}
export interface CustomerProfile {decisionChain:string;goals:string;concerns:string;budget:string;timeline:string;}
export interface CompanyProfileSource {id:string;title:string;url:string;provider:'qcc'|'jinghai'|'web';retrievedAt:string;snippet?:string;}
export interface CompanyProfile {companyName:string;summary:string;facts:{label:string;value:string;sourceIds:string[]}[];sources:CompanyProfileSource[];provider:'qcc'|'jinghai'|'web';status:'ready'|'partial';warnings:string[];updatedAt:string;modelUsed:boolean;}
export interface Deal {intelligence?:SalesIntelligence;intake?:{requestId:string;rawText:string;inputMode:'text'|'speech';capturedAt:string};deadline?:string;cardColor?:string;outcome?:'open'|'won'|'lost';wonAt?:string;id:string; name:string; projectName?:string;source?:string;website?:string;region?:string;createdAt?:string;dataOrigin?:'sample'|'manual';customerProfile?:CustomerProfile;companyProfile?:CompanyProfile;contact:string; position:string; industry:string; owner:string; ownerId:string; stage:string; amount:number; health:number; priority:'high'|'medium'|'low'; lastContact:string; nextAction:string; summary:string; needs:string[]; risks:string[]; notes:{id:string;text:string;author:string;date:string;intakeRequestId?:string;inputMode?:'text'|'speech';recording?:FollowupRecording}[]; version:number; avatar:string;}
export interface Skill {id:string;title:string;category:string;status:'candidate'|'published'|'rejected';author:string;description:string;scenario:string;steps:string[];boundaries:string[];evidence:string;source:string;version:number;reviewer?:string;reviewNote?:string;updatedAt:string;}
export interface Knowledge {id:string;title:string;category:string;content:string;source:string;status:'published'|'draft';updatedAt:string;}
export type NodeType = 'start'|'intent'|'knowledge'|'agent'|'review'|'output';
export interface FlowNode {id:string;type:NodeType;label:string;x:number;y:number;agentId?:AgentId;instruction?:string;knowledgeIds?:string[];}
export interface FlowEdge {from:string;to:string;condition?:AgentId|'default';}
export interface PublishedWorkflow {name:string;description:string;kind?:'agent'|'workflow';nodes:FlowNode[];edges:FlowEdge[];version:number;publishedAt:string;}
export interface Workflow {id:string;name:string;description:string;kind?:'agent'|'workflow';status:'draft'|'published';nodes:FlowNode[];edges:FlowEdge[];version:number;updatedAt:string;published?:PublishedWorkflow;}
export interface TraceStep {id:string;title:string;agent?:AgentId;nodeId?:string;input?:string;output?:string;detail:string;duration:number;status:'success'|'warning'|'error'|'skipped';}
export interface Run {id:string;query:string;answer:string;agentIds:AgentId[];steps:TraceStep[];citations:{id:string;title:string;excerpt:string}[];mode:'demo'|'live';createdAt:string;duration:number;dealId?:string;workflowId?:string;status?:'completed'|'paused'|'failed'|'rejected';workflowVersion?:number;workflowSource?:'draft'|'published';awaitingNodeId?:string;review?:{reviewer:string;decision:'approve'|'reject';note:string;date:string};}
export interface TrainingSession {id:string;scenario:string;customer:string;profile?:TrainingProfile;mode?:'demo'|'live';messages:{role:'user'|'assistant';content:string}[];status:'active'|'completed';voiceTurnIds?:string[];score?:number;feedback?:{label:string;score:number;evidence:string;suggestion:string}[];createdAt:string;}
export interface Activity {id:string;title:string;detail:string;date:string;type:string;}
export interface WorkbenchState {contracts?:ContractDocument[];transcripts?:CallTranscript[];talkTracks?:TalkTrack[];feedbackJobs?:FeedbackJob[];talkTrackUsages?:TalkTrackUsage[];talkTrackPolicy?:TalkTrackPolicy;revision:number;role:Role;viewer:{name:string;team:string;salesId:string};dataMode:'example';model:{connected:boolean;name:string};deals:Deal[];skills:Skill[];knowledge:Knowledge[];workflows:Workflow[];runs:Run[];trainingSessions:TrainingSession[];activities:Activity[];}
export interface ApiResult {intake?:{status:'needs_info'|'duplicate';question?:string;draft?:IntakeExtraction;existing?:{id:string;name:string;projectName:string}[]};contractId?:string;state:WorkbenchState;run?:Run;session?:TrainingSession;dealId?:string;message?:string;}
export type Mutate = (action:string,payload?:Record<string,unknown>) => Promise<ApiResult>;
export interface ViewProps {state:WorkbenchState;mutate:Mutate;notify:(message:string)=>void;onAsk:(query:string,agentId?:AgentId,dealId?:string,talkTrackIds?:string[])=>void;}
