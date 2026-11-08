import {scopeFor} from './sales-scope.ts';
import { DomainError } from './domain.ts';
import { DEFAULT_TALKTRACK_POLICY } from './talktrack-types.ts';
import type { CallTranscript, TalkTrack, TalkTrackPolicy } from './talktrack-types.ts';
import type { Deal, Knowledge, Role, WorkbenchState } from './types.ts';
const id=(prefix:string)=>`${prefix}-${crypto.randomUUID()}`;
function fail(message:string,status=400):never{throw new DomainError(message,status);}
function str(value:unknown,label:string,max=5000):string{if(typeof value!=='string'||!value.trim()||value.length>max)fail(`请检查${label}（最多${max}字）`);return value.trim();}
function strings(value:unknown,label:string,max=20):string[]{if(!Array.isArray(value)||value.length>max)fail(`${label}格式不正确`);return value.map(v=>str(v,label,500));}
export function talkText(track:Pick<TalkTrack,'topic'|'scenario'|'template'|'keywords'|'objectionLogic'|'steps'|'boundaries'|'leadTypes'>):string {
  return [track.topic,`适用场景：${track.scenario}`,`话术模板：${track.template}`,`关键词：${track.keywords.join('、')}`,`应对逻辑：${track.objectionLogic.join('；')}`,`步骤：${track.steps.join('；')}`,`边界：${track.boundaries.join('；')}`,`线索类型：${track.leadTypes.join('、')}`].join('\n');
}
export function talkTitle(employee:string,topic:string,version:number):string {return `${employee}${topic.replace(/话术$/,'')}话术 v1.${version-1}`;}
export function feedbackBatches(sources:CallTranscript[]):CallTranscript[][]{const batches:CallTranscript[][]=[];for(const employeeId of new Set(sources.map(t=>t.employeeId))){let batch:CallTranscript[]=[];let length=0;for(const source of sources.filter(t=>t.employeeId===employeeId)){if(batch.length&&(length+source.text.length>100000||batch.length>=40)){batches.push(batch);batch=[];length=0;}batch.push(source);length+=source.text.length;}if(batch.length)batches.push(batch);}return batches;}
export async function transcriptHash(deal:Deal,transcripts:CallTranscript[]):Promise<string>{const bytes=new TextEncoder().encode(JSON.stringify([deal.id,deal.outcome,deal.wonAt,transcripts.map(t=>[t.id,t.employeeId,t.text])]));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function queueFeedback(state:WorkbenchState,deal:Deal,now:string,retry=false){
  if(deal.outcome!=='won'||deal.dataOrigin!=='manual')return;
  const transcripts=(state.transcripts??[]).filter(t=>t.dealId===deal.id);const sourceHash=await transcriptHash(deal,transcripts);
  const jobs=state.feedbackJobs??=[];const existing=jobs.find(j=>j.dealId===deal.id&&j.sourceHash===sourceHash);
  if(existing){if(retry&&['failed','waiting_config','queued','duplicate','screened_out'].includes(existing.status)){existing.status='queued';existing.message='等待自动提炼';existing.updatedAt=now;}return;}
  // A new transcript invalidates an in-flight older source snapshot.
  for(const job of jobs.filter(j=>j.dealId===deal.id&&['queued','running','waiting_transcript','waiting_config','failed'].includes(j.status))){job.status='done';job.message='已由更新的转写任务替代';delete job.leaseToken;delete job.leaseUntil;}
  jobs.unshift({id:id('feedback'),dealId:deal.id,status:transcripts.length?'queued':'waiting_transcript',message:transcripts.length?'等待自动提炼':'成单已确认，补充通话转写后自动提炼',sourceHash,candidateIds:[],createdAt:now,updatedAt:now});
}
export function approvedTracks(state:WorkbenchState,ids:unknown):TalkTrack[]{
  if(ids===undefined)return [];
  if(!Array.isArray(ids)||ids.length>5||ids.some(v=>typeof v!=='string'))fail('最多选择5条已发布话术');
  return [...new Set(ids as string[])].map(key=>{const track=state.talkTracks?.find(t=>t.id===key&&t.status==='published'&&t.weight>0);if(!track)fail('所选话术尚未发布或已归档，请重新选择',409);return track;});
}
export function talkKnowledge(track:TalkTrack):Knowledge{return {id:track.id,title:track.title,category:'实战话术',content:talkText(track),source:`销售管理者审核；成单案例提炼，统计成单率另行验证`,status:'published',updatedAt:track.updatedAt};}
export function closeStats(state:WorkbenchState,trackId:string){const ids=new Set((state.talkTrackUsages??[]).filter(u=>u.trackId===trackId).map(u=>u.dealId));const closed=state.deals.filter(d=>ids.has(d.id)&&d.dataOrigin==='manual'&&['won','lost'].includes(d.outcome??''));return {closed:closed.length,won:closed.filter(d=>d.outcome==='won').length};}
export function maintainTalkTracks(state:WorkbenchState,now:string):number{
  const policy=state.talkTrackPolicy??DEFAULT_TALKTRACK_POLICY;if(!policy.enabled)return 0;let count=0;
  for(const track of state.talkTracks??[]){if(track.status!=='published')continue;const stats=closeStats(state,track.id);const latest=(state.talkTrackUsages??[]).filter(u=>u.trackId===track.id).reduce((a,u)=>u.usedAt>a?u.usedAt:a,track.publishedAt??track.createdAt);
    if(stats.closed<policy.minClosedProjects||stats.won/stats.closed>=policy.winRateBelow||Date.parse(now)-Date.parse(latest)<policy.idleDays*86400000)continue;
    if(policy.action==='archive')track.status='archived';else if(track.weight<=0.5)continue;else track.weight=0.5;
    track.reviewNote=`自动维护：${stats.closed}个已结项项目，${stats.won}个成单；${policy.action==='archive'?'归档':'降低检索权重'}。使用相关性不代表因果成单率。`;track.updatedAt=now;track.version++;count++;
  }state.talkTrackPolicy={...policy,lastRunAt:now};return count;
}
export async function handleTalkAction(state:WorkbenchState,role:Role,action:string,payload:Record<string,unknown>,now:string,approve?:(track:TalkTrack)=>Promise<void>,actorName?:string):Promise<string|null>{
  const deal=()=>{const d=state.deals.find(d=>d.id===payload.dealId);if(!d)fail('项目不存在',404);if(role==='sales'&&d.ownerId!==scopeFor(state).salesId)fail('无权操作其他销售的项目',403);return d;};
  switch(action){
    case 'deal_outcome':{const d=deal();if(payload.version!==d.version)fail('项目已更新，请刷新后重试',409);if(payload.confirmed!==true||!['open','won','lost'].includes(String(payload.outcome)))fail('请确认项目成单或结项结果');if(d.outcome===payload.outcome)fail('项目结果没有变化',409);d.outcome=payload.outcome as Deal['outcome'];d.version++;if(d.outcome==='won'){d.wonAt=now;await queueFeedback(state,d,now);}else{delete d.wonAt;for(const j of state.feedbackJobs??[])if(j.dealId===d.id){j.status='done';j.message='项目结果已变更，自动提炼停止';delete j.leaseToken;delete j.leaseUntil;}for(const t of state.talkTracks??[])if(t.dealId===d.id&&t.status!=='rejected'){t.status='archived';t.updatedAt=now;t.version++;t.reviewNote='来源项目已撤销成单，需要重新核实来源';}}return '项目结果已保存';}
    case 'transcript_add':{const d=deal();if(!['pasted','file'].includes(String(payload.source)))fail('请选择转写文本来源');const value=str(payload.text,'通话转写',50000);const all=state.transcripts??=[];if(all.reduce((sum,t)=>sum+t.text.length,0)+value.length>500000)fail('当前工作空间转写容量已满，请联系管理员扩容',413);if(all.some(t=>t.dealId===d.id&&t.text===value))fail('这段转写已保存，无需重复提交',409);all.unshift({id:id('transcript'),dealId:d.id,employeeId:d.ownerId,employeeName:d.owner,text:value,source:payload.source as 'pasted'|'file',createdAt:now});d.version++;d.lastContact=now.slice(0,10);await queueFeedback(state,d,now);return '通话转写已保存，成单项目自动进入提炼流程';}
    case 'feedback_retry':{const d=deal();if(d.outcome!=='won'||d.dataOrigin!=='manual')fail('只有已确认成单的正式项目可提炼话术');await queueFeedback(state,d,now,true);return '已检查并恢复待处理任务';}
    case 'talktrack_archive':
    case 'talktrack_weight':{
      if(role!=='manager')fail('需要知识内容运营权限',403);
      if(Object.keys(payload).some(key=>!['id','version','weight','note'].includes(key)))fail('只能调整已发布话术的检索权重或停用状态');
      const track=state.talkTracks?.find(item=>item.id===payload.id);if(!track)fail('话术不存在',404);
      if(track.version!==payload.version||track.status!=='published')fail('话术已更新或尚未发布，请刷新后重试',409);
      if(action==='talktrack_weight'){
        if(typeof payload.weight!=='number'||!Number.isFinite(payload.weight)||payload.weight<0||payload.weight>1)fail('检索权重须为0至1之间的数值');
        track.weight=payload.weight;
      }else track.status='archived';
      track.reviewNote=[actorName??'周予安',typeof payload.note==='string'?payload.note.trim().slice(0,2800):action==='talktrack_archive'?'知识运营已停用此话术':'知识运营已调整检索权重'].join(' · ');
      track.version++;track.updatedAt=now;
      return action==='talktrack_archive'?'话术已停用，不再用于检索生成':'话术检索权重已更新';
    }
    case 'talktrack_review':{if(role!=='manager')fail('需要销售管理者审核',403);const t=state.talkTracks?.find(t=>t.id===payload.id);if(!t)fail('话术不存在',404);if(t.version!==payload.version)fail('话术已更新，请刷新后重试',409);const decision=payload.decision;if(!['approve','reject','restore'].includes(String(decision)))fail('审核操作不正确');if((decision==='restore'?t.status!=='archived':t.status!=='candidate'))fail('话术状态已变更',409);
      if(payload.edits!==undefined){if(!payload.edits||typeof payload.edits!=='object'||Array.isArray(payload.edits))fail('微调格式不正确');const edits=payload.edits as Record<string,unknown>;if(Object.keys(edits).some(k=>!['topic','scenario','template','keywords','objectionLogic','steps','boundaries','leadTypes'].includes(k)))fail('不能修改来源、作者或原文证据');for(const key of ['topic','scenario','template'] as const)if(key in edits)t[key]=str(edits[key],key,key==='topic'?60:8000);for(const key of ['keywords','objectionLogic','steps','boundaries','leadTypes'] as const)if(key in edits)t[key]=strings(edits[key],key);}
      if(decision!=='reject'){const d=state.deals.find(d=>d.id===t.dealId);if(!d||d.outcome!=='won'||d.dataOrigin!=='manual')fail('来源项目尚未确认成单');if(!approve)fail('向量服务未配置，请先在设置中连接 Embedding API',503);await approve(t);t.status='published';t.publishedAt=now;t.weight=1;}else t.status='rejected';
      t.reviewNote=typeof payload.note==='string'?payload.note.trim().slice(0,3000):'';t.reviewer=actorName??'周予安';t.updatedAt=now;t.version++;t.title=talkTitle(t.employeeName,t.topic,t.version);
      for(const j of state.feedbackJobs??[])if(j.candidateIds.includes(t.id)&&j.candidateIds.every(key=>state.talkTracks?.find(track=>track.id===key)?.status!=='candidate')){j.status='done';j.message='候选话术已完成审核';j.updatedAt=now;}
      return decision==='reject'?'话术已打回':'话术已审核发布，可在生成时指定使用';}
    case 'talktrack_policy':{if(role!=='manager')fail('需要销售管理者设置维护策略',403);if(typeof payload.enabled!=='boolean'||!['downweight','archive'].includes(String(payload.action)))fail('维护策略格式不正确');for(const [key,min,max] of [['minClosedProjects',10,10000],['idleDays',1,3650],['winRateBelow',0,1]] as const)if(typeof payload[key]!=='number'||!Number.isFinite(payload[key])||(payload[key] as number)<min||(payload[key] as number)>max||(key!=='winRateBelow'&&!Number.isInteger(payload[key])))fail('请检查维护阈值（至少10个已结项项目）');state.talkTrackPolicy={enabled:payload.enabled,minClosedProjects:payload.minClosedProjects as number,winRateBelow:payload.winRateBelow as number,idleDays:payload.idleDays as number,action:payload.action as TalkTrackPolicy['action']};return '维护策略已保存';}
    default:return null;
  }
}
