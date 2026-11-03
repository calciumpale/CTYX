import {DomainError,executeAction,projectState} from './domain.ts';
import type {ActionContext} from './domain.ts';
import type {MemberRole} from './member-types.ts';
import type {ApiResult,Run,WorkbenchState} from './types.ts';

const denied=():never=>{throw new DomainError('当前账号没有此操作权限',403);};
type AccountRun=Run&{systemTask?:true};
export function requireMemberRole(request:Request):MemberRole {
  const role=request.headers.get('x-ctai-member-role');
  if(request.headers.get('x-ctai-member-authenticated')!=='1'||!request.headers.get('x-ctai-member-account-id')||!request.headers.get('x-ctai-member-username')||!['sales','manager','admin'].includes(role??''))throw new DomainError('请先登录工作台',401);
  return role as MemberRole;
}
export function readMemberDisplayName(request:Request):string {
  requireMemberRole(request);let name=request.headers.get('x-ctai-member-display-name')??request.headers.get('x-ctai-member-username')??'';
  try{name=decodeURIComponent(name).trim();}catch{throw new DomainError('登录姓名无效，请重新登录',401);}
  if(!name||name.length>200||/[\u0000-\u001f\u007f]/.test(name))throw new DomainError('登录姓名无效，请重新登录',401);
  return name;
}
/** Endpoint access is enforced before handlers, including handlers which do not use server.ts. */
export function assertMemberApi(role:MemberRole,pathname:string,method:string):void {
  const path=pathname.replace(/\/$/,'');const verb=method.toUpperCase();
  if(path==='/api/workbench'){if(['GET','POST'].includes(verb))return;return denied();}
  if(path==='/api/meeting-imports'){if(verb==='GET'||role!=='admin'&&verb==='POST')return;return denied();}
  if(/^\/api\/meeting-imports\/media\/[a-zA-Z0-9_.:-]+$/.test(path)){if(role!=='admin'&&['GET','HEAD'].includes(verb))return;return denied();}
  if(path==='/api/approvals'){if(['GET','POST'].includes(verb))return;return denied();}
  if(path==='/api/business-settings'){if(verb==='GET'||role==='admin'&&verb==='POST')return;return denied();}
  if(['/api/connections','/api/embedding-connection','/api/company-connection'].includes(path)){if(role==='admin'&&['GET','POST'].includes(verb))return;return denied();}
  if(path==='/api/workspace-members'){if(role==='admin'&&['GET','POST','PATCH'].includes(verb))return;return denied();}
  if(path==='/api/speech-settings'){if(verb==='GET'||verb==='POST'&&role!=='sales')return;return denied();}
  if(path==='/api/sales-reports'){if(role==='manager'&&['GET','POST'].includes(verb))return;return denied();}
  if(['/api/deal-recordings','/api/recording-transcriptions','/api/training-voice'].includes(path)){if(role!=='admin'&&['GET','HEAD','POST','DELETE'].includes(verb))return;return denied();}
  return denied();
}
export function assertMemberRoute(request:Request,role:MemberRole):void {
  const url=new URL(request.url);assertMemberApi(role,url.pathname,request.method);
  if(role==='admin'&&url.pathname.replace(/\/$/,'')==='/api/approvals'&&request.method==='GET'&&(url.searchParams.get('scope')!=='templates'||url.searchParams.has('id')))denied();
}
const customerActions=new Set(['deal_intake','deal_intake_followup','deal_assess','deal_create','deal_update','deal_enrich','deal_note','deal_stage','deal_outcome','transcript_add','feedback_retry','skill_candidate','chat','contract_save','contract_review','contract_finding_status','training_start','training_reply','training_finish']);
const contentActions=new Set(['knowledge_add','talktrack_policy','talktrack_archive','talktrack_weight']);
const builderActions=new Set(['workflow_save','workflow_publish','workflow_run','workflow_review']);
export function assertMemberAction(role:MemberRole,action:string,payload:Record<string,unknown>,state?:WorkbenchState):void {
  if(action==='switch_role')return denied();
  if(customerActions.has(action)){if(role!=='admin')return;return denied();}
  if(action==='skill_review'||action==='talktrack_review'){if(role==='manager')return;return denied();}
  if(contentActions.has(action)){if(role!=='sales')return;return denied();}
  if(builderActions.has(action)){
    if(role==='admin'){
      if(payload.dealId)return denied();
      if(action==='workflow_review'){
        const run=state?.runs.find(item=>item.id===payload.runId);
        if(!run||run.dealId||!(run as AccountRun).systemTask)return denied();
      }
      return;
    }
    if(action==='workflow_run'&&payload.mode==='published'&&payload.workflow===undefined)return;
    if(role==='manager'&&action==='workflow_review'){
      const run=state?.runs.find(item=>item.id===payload.runId);
      if(run?.workflowSource==='published'&&!(run as AccountRun).systemTask)return;
    }
    return denied();
  }
  return denied();
}
/** Builder debugging runs against customer-free context, then merges untouched business records back. */
export async function executeMemberAction(state:WorkbenchState,role:MemberRole,action:string,payload:Record<string,unknown>,context:ActionContext={}):Promise<ApiResult>{
  assertMemberAction(role,action,payload,state);
  const isolated=role==='admin'&&(action==='workflow_run'||action==='workflow_review');
  const input=isolated?{...state,deals:[],contracts:[],transcripts:[],trainingSessions:[]}:state;
  const result=await executeAction(input,role==='sales'?'sales':'manager',action,payload,context);
  if(isolated){
    result.state.deals=structuredClone(state.deals);result.state.contracts=structuredClone(state.contracts);result.state.transcripts=structuredClone(state.transcripts);result.state.trainingSessions=structuredClone(state.trainingSessions);
    if(result.run){(result.run as AccountRun).systemTask=true;const stored=result.state.runs.find(run=>run.id===result.run!.id);if(stored)(stored as AccountRun).systemTask=true;}
  }
  return result;
}
export function assertMemberApprovalAction(role:MemberRole,action:string):void {
  if(action==='template_save'||action==='template_delete'){if(role!=='sales')return;return denied();}
  if(action==='decide'){if(role==='manager')return;return denied();}
  if(action==='submit'||action==='withdraw'){if(role!=='admin')return;return denied();}
  return denied();
}
function operationalRun(run:Run):Run {
  if((run as AccountRun).systemTask&&!run.dealId)return structuredClone(run);
  return {id:run.id,query:'任务记录',answer:'',agentIds:[...run.agentIds],steps:run.steps.map(step=>({id:step.id,title:'执行步骤',...(step.agent?{agent:step.agent}:{}),...(step.nodeId?{nodeId:step.nodeId}:{}),detail:'',duration:step.duration,status:step.status})),citations:[],mode:run.mode,createdAt:run.createdAt,duration:run.duration,...(run.workflowId?{workflowId:run.workflowId}:{}),...(run.status?{status:run.status}:{}),...(run.workflowVersion?{workflowVersion:run.workflowVersion}:{}),...(run.workflowSource?{workflowSource:run.workflowSource}:{})};
}
/** Never expose raw canonical state to the admin account, including on write responses. */
export function projectAccountState(role:MemberRole,state:WorkbenchState):WorkbenchState {
  if(role==='sales')return projectState(state,'sales');
  const result=projectState(state,'manager');
  if(role==='manager'){
    result.workflows=result.workflows.filter(workflow=>workflow.published||workflow.status==='published').map(workflow=>workflow.published?{id:workflow.id,...workflow.published,status:'published',updatedAt:workflow.published.publishedAt}:workflow);
    result.runs=result.runs.filter(run=>!(run as AccountRun).systemTask);
    return result;
  }
  const clean=result;
  clean.deals=[];clean.contracts=[];clean.transcripts=[];clean.feedbackJobs=[];clean.talkTrackUsages=[];clean.trainingSessions=[];clean.activities=[];
  clean.skills=clean.skills.filter(skill=>skill.status==='published');
  clean.talkTracks=clean.talkTracks?.filter(track=>track.status==='published'||track.status==='archived').map(track=>({...track,dealId:''}));
  clean.runs=clean.runs.map(operationalRun);
  clean.viewer={name:'管理员',team:'系统管理',salesId:''};
  return clean;
}
export function projectAccountResult(role:MemberRole,result:ApiResult):ApiResult {
  const state=projectAccountState(role,result.state);
  if(role!=='admin')return {...result,state};
  return {state,...(result.run?{run:operationalRun(result.run)}:{}),message:'操作已完成'};
}
