import {markSalesBusinessChanges} from './sales-project-eligibility.ts';
import type {SalesScope} from './sales-scope.ts';
import {DomainError,projectState} from './domain.ts';
import {authorizedRecording,recordingObjectKey} from './followup-recordings.ts';
import {queueFeedback} from './talktrack-domain.ts';
import {salesMutationEvents} from './sales-report-domain.ts';
import {createSpeechSettingsStore,readSpeechJson,speechGateway} from './speech-settings.ts';
import type {SpeechEnvironment,SpeechFetch} from './speech-settings.ts';
import {SPEECH_DIALECTS} from './speech-types.ts';
import type {SpeechResult,SpeechTranscriptionJob} from './speech-types.ts';
import type {Role,WorkbenchState} from './types.ts';
import type {SalesEvent} from './sales-report-types.ts';

interface Environment extends SpeechEnvironment {BUCKET?:R2Bucket;}
interface JobRow {version:number;remote_id:string|null;lease_until:string|null;data_json:string;}
interface WorkspaceDependencies {load:(userId:string,origin:string)=>Promise<WorkbenchState>;save:(userId:string,revision:number,state:WorkbenchState,events?:SalesEvent[])=>Promise<void>;refresh?:(userId:string,dealId:string,origin:string)=>Promise<unknown>;feedback?:(userId:string,dealId:string,origin:string)=>Promise<void>;}
const safeFailure='转写服务暂时无法处理录音，请检查语音服务后重试；原录音已保存';
function transcriptionFailure(code:unknown):string {
  switch(code){
    case 'hotword_budget':return '启用热词超出当前识别模型的单段容量，请在语音设置中关闭暂不用的词条后重新转写；原录音已保存';
    case 'no_speech':return '未识别到有效讲话，请检查录音是否清晰并包含语音后重试；原录音已保存';
    case 'duration':return '录音时长不能超过2小时，请分段后重新上传；原录音已保存';
    case 'decode':return '录音无法解码，请转换为 MP3、WAV 或 M4A 格式后重新上传；原录音已保存';
    case 'internal':
    default:return safeFailure;
  }
}
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('转写服务返回格式无效',502);return value as Record<string,unknown>;};
const text=(value:unknown,max:number,empty=false):string=>{if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))throw new DomainError('转写服务返回文本无效',502);return value;};
const number=(value:unknown,max:number):number=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max)throw new DomainError('转写服务返回时间或进度无效',502);return value;};
export function parseSpeechResult(value:unknown):SpeechResult {
  const result=object(value);if(!Array.isArray(result.segments)||result.segments.length>6000||!Array.isArray(result.speakers)||result.speakers.length>30||!Array.isArray(result.corrections)||result.corrections.length>250)throw new DomainError('转写服务返回分段无效',502);
  const durationSeconds=number(result.durationSeconds,7200),speakers=result.speakers.map(raw=>{const speaker=object(raw);return {id:text(speaker.id,100),label:text(speaker.label,100)};});
  const speakerIds=new Set(speakers.map(s=>s.id));if(speakerIds.size!==speakers.length)throw new DomainError('转写讲话人编号重复',502);
  const segments=result.segments.map(raw=>{const segment=object(raw),start=number(segment.start,durationSeconds+1),end=number(segment.end,durationSeconds+1),speaker=text(segment.speaker,100);if(end<start||(!speakerIds.has(speaker)&&speaker!=='unknown'))throw new DomainError('转写讲话人或时间区间无效',502);return {start,end,speaker,text:text(segment.text,12000,true),rawText:text(segment.rawText,12000,true)};});
  if(!SPEECH_DIALECTS.includes(result.dialectHint as SpeechResult['dialectHint'])||typeof result.diarization!=='boolean'||!Number.isSafeInteger(result.hotwordVersion)||(result.hotwordVersion as number)<0)throw new DomainError('转写服务返回识别设置无效',502);
  const parsed:SpeechResult={text:text(result.text,100000),rawText:text(result.rawText,100000),segments,speakers,corrections:result.corrections.map(raw=>{const correction=object(raw);const count=number(correction.count,100000);if(!Number.isInteger(count)||count<1)throw new DomainError('转写纠偏次数无效',502);return {from:text(correction.from,40),to:text(correction.to,40),count};}),model:text(result.model,160),durationSeconds,dialectHint:result.dialectHint as SpeechResult['dialectHint'],diarization:result.diarization,hotwordVersion:result.hotwordVersion as number};
  if(new TextEncoder().encode(JSON.stringify(parsed)).length>1800000)throw new DomainError('分段转写结果过大，请拆分录音后重试',413);return parsed;
}
function remoteJob(value:unknown,previous:SpeechTranscriptionJob):{job:SpeechTranscriptionJob;remoteId:string}{
  const data=object(object(value).job),id=text(data.id,100);if(!/^[a-f0-9]{32}$/.test(id)||data.recordingId!==previous.recordingId||!['queued','running','completed','failed'].includes(String(data.status)))throw new DomainError('转写任务与当前录音不匹配',502);
  const status=data.status as SpeechTranscriptionJob['status'];const progress=Math.round(number(data.progress,100));const job={...previous,status,progress,updatedAt:new Date().toISOString(),message:status==='failed'?transcriptionFailure(data.errorCode):status==='completed'?'转写完成':status==='running'?'正在识别录音、区分讲话人并应用热词表':'录音已排队，等待识别',...(status==='completed'?{result:parseSpeechResult(data.result)}:{})};return {remoteId:id,job};
}
export async function signRecordingSession(secret:string,userId:string,recordingId:string,now=Math.floor(Date.now()/1000)):Promise<string>{
  const encode=(value:unknown)=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const body=`${encode({alg:'HS256',typ:'JWT'})}.${encode({aud:'recording-asr',sub:userId,recordingId,iat:now,exp:now+300,jti:crypto.randomUUID()})}`;
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signature=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body)));return `${body}.${btoa(String.fromCharCode(...signature)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}`;
}
/** Full results stay in D1; bounded, attributed excerpts enter existing project intelligence. */
export async function linkSpeechTranscript(state:WorkbenchState,dealId:string,recordingId:string,result:SpeechResult,now=new Date().toISOString()):Promise<{state:WorkbenchState;changed:boolean;truncated:boolean}>{
  const next=structuredClone(state),deal=next.deals.find(d=>d.id===dealId);if(!deal)throw new DomainError('项目已不存在，转写原文仍保留',404);authorizedRecording(next,dealId,recordingId);
  const id=`transcript-asr-${recordingId}`,all=next.transcripts??=[],existing=all.find(source=>source.id===id);
  if(existing&&existing.dealId!==dealId)throw new DomainError('转写来源与当前项目不匹配，原记录已保留',409);
  const remaining=500000-all.reduce((sum,t)=>sum+t.text.length,0)+(existing?.text.length??0),limit=Math.min(50000,remaining);next.transcripts=all;if(limit<100)throw new DomainError('项目转写容量已满；完整转写已单独保存，清理空间后会重新关联',413);
  const labels=new Map(result.speakers.map(speaker=>[speaker.id,speaker.label]));
  const clock=(seconds:number)=>`${Math.floor(seconds/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
  const formatted=result.segments.length?`（讲话人编号仅代表声音聚类，尚未确认销售或客户身份；时间为语音分段区间。）\n${result.segments.map(segment=>`[${clock(segment.start)}–${clock(segment.end)}] ${labels.get(segment.speaker)??'未区分讲话人'}：${segment.text}`).join('\n')}`:result.text;
  const truncated=formatted.length>limit,content=truncated?`${formatted.slice(0,limit-60)}\n（长录音仅将前段用于项目分析，完整原文请在录音转写中查看。）`:formatted;
  if(existing?.text===content)return {state:next,changed:false,truncated};
  if(existing)existing.text=content;
  else all.unshift({id,dealId,employeeId:deal.ownerId,employeeName:deal.owner,text:content,source:'file',createdAt:now});
  deal.version++;next.revision++;markSalesBusinessChanges(state,next,now);await queueFeedback(next,deal,now);return {state:next,changed:true,truncated};
}
export function createSpeechTranscriptionService(environment:Environment,deps:WorkspaceDependencies,request:SpeechFetch=fetch){
  const database=()=>{if(!environment.DB)throw new DomainError('转写任务存储尚未就绪',503);return environment.DB;};
  const find=async(userId:string,recordingId:string)=>database().prepare('SELECT version,remote_id,lease_until,data_json FROM workbench_recording_transcriptions WHERE user_id = ? AND recording_id = ?').bind(userId,recordingId).first<JobRow>();
  const authorize=async(userId:string,role:Role,dealId:string,recordingId:string,origin:string,salesScope?:SalesScope)=>{if(!userId||userId.length>512)throw new DomainError('请先登录',401);const state=await deps.load(userId,origin);return authorizedRecording(projectState(state,role,salesScope),dealId,recordingId);};
  const persist=async(userId:string,row:JobRow,job:SpeechTranscriptionJob,remoteId=row.remote_id)=>{const saved=await database().prepare('UPDATE workbench_recording_transcriptions SET version = ?,remote_id = ?,lease_until = NULL,updated_at = ?,data_json = ? WHERE user_id = ? AND recording_id = ? AND version = ?').bind(row.version+1,remoteId,job.updatedAt,JSON.stringify(job),userId,job.recordingId,row.version).run();return saved.meta.changes===1;};
  async function link(userId:string,row:JobRow,job:SpeechTranscriptionJob,origin:string):Promise<SpeechTranscriptionJob>{
    if(job.status!=='completed'||!job.result||job.linked)return job;
    try{for(let retry=0;retry<3;retry++){const before=await deps.load(userId,origin),linked=await linkSpeechTranscript(before,job.dealId,job.recordingId,job.result);if(linked.changed){try{await deps.save(userId,before.revision,linked.state,salesMutationEvents(before,linked.state,'transcript_add',{dealId:job.dealId},new Date().toISOString()));}catch(error){if(error instanceof DomainError&&error.status===409&&retry<2)continue;throw error;}}
        const updated={...job,linked:true,updatedAt:new Date().toISOString(),message:linked.truncated?'完整转写已保存，项目分析已关联容量范围内的前段':'转写已保存并关联项目'};await persist(userId,row,updated);if(linked.changed){try{await deps.refresh?.(userId,job.dealId,origin);await deps.feedback?.(userId,job.dealId,origin);}catch{/* Saved source and task completion survive downstream model failures. */}}return updated;}
    }catch(error){const updated={...job,message:error instanceof DomainError?error.message:'转写已保存，项目分析暂未更新；重新打开录音后自动重试',updatedAt:new Date().toISOString()};await persist(userId,row,updated);return updated;}
    return job;
  }
  async function start(userId:string,role:Role,dealId:string,recordingId:string,origin:string,retry=false,salesScope?:SalesScope):Promise<SpeechTranscriptionJob>{
    const recording=await authorize(userId,role,dealId,recordingId,origin,salesScope);let row=await find(userId,recordingId);const previous=row?JSON.parse(row.data_json) as SpeechTranscriptionJob:null;
    if(previous&&previous.dealId!==dealId)throw new DomainError('录音不存在或当前视角无权访问',404);
    if(previous&&(previous.status==='completed'&&!retry||previous.status==='running'||previous.status==='queued'&&(row!.remote_id||Date.parse(row!.lease_until??'')>Date.now())||previous.status==='failed'&&!retry))return previous;
    const now=new Date().toISOString(),job:SpeechTranscriptionJob={id:`asr-${crypto.randomUUID()}`,recordingId,dealId,status:'queued',progress:0,message:'正在提交识别任务',createdAt:now,updatedAt:now,linked:false,...(previous?.result?{result:previous.result}:{})};const version=(row?.version??0)+1,until=new Date(Date.now()+90000).toISOString();
    const claim=row?await database().prepare('UPDATE workbench_recording_transcriptions SET version = ?,remote_id = NULL,lease_until = ?,updated_at = ?,data_json = ? WHERE user_id = ? AND recording_id = ? AND version = ?').bind(version,until,now,JSON.stringify(job),userId,recordingId,row.version).run():await database().prepare('INSERT INTO workbench_recording_transcriptions (user_id,recording_id,deal_id,version,remote_id,lease_until,updated_at,data_json) VALUES (?,?,?,?,NULL,?,?,?) ON CONFLICT(user_id,recording_id) DO NOTHING').bind(userId,recordingId,dealId,version,until,now,JSON.stringify(job)).run();
    if(claim.meta.changes!==1){const latest=await find(userId,recordingId);if(latest)return JSON.parse(latest.data_json) as SpeechTranscriptionJob;throw new DomainError('转写任务正在更新，请重试',409);}row={version,remote_id:null,lease_until:until,data_json:JSON.stringify(job)};
    try{const gateway=speechGateway(environment,origin);if(!gateway)throw new DomainError('录音已保存，配置并启动语音网关后可重试转写',503);if(!environment.BUCKET)throw new DomainError('录音存储暂时不可用；原录音已保存',503);
      const audio=await environment.BUCKET.get(await recordingObjectKey(userId,recordingId));if(!audio||audio.size!==recording.size)throw new DomainError('原录音暂时无法读取，请稍后重试',404);
      const settings=await createSpeechSettingsStore(environment).read(userId),form=new FormData();form.append('file',new Blob([await audio.arrayBuffer()],{type:recording.mimeType}),recording.name);form.append('options',JSON.stringify({...settings,hotwordVersion:settings.version,retry}));
      const response=await request(`${gateway.url}/transcriptions`,{method:'POST',headers:{Authorization:`Bearer ${await signRecordingSession(gateway.secret,userId,recordingId)}`},body:form,redirect:'manual',signal:AbortSignal.timeout(45000)});if(!response.ok)throw new DomainError(safeFailure,response.status===413?413:503);const remote=remoteJob(await readSpeechJson(response,1950000),job);await persist(userId,row,remote.job,remote.remoteId);const updated=await find(userId,recordingId);return updated?link(userId,updated,JSON.parse(updated.data_json),origin):remote.job;
    }catch(error){const failed={...job,status:'failed' as const,message:error instanceof DomainError?error.message:safeFailure,updatedAt:new Date().toISOString()};await persist(userId,row,failed);return failed;}
  }
  async function read(userId:string,role:Role,dealId:string,recordingId:string,origin:string,salesScope?:SalesScope):Promise<SpeechTranscriptionJob|null>{
    await authorize(userId,role,dealId,recordingId,origin,salesScope);let row=await find(userId,recordingId);if(!row)return null;let job=JSON.parse(row.data_json) as SpeechTranscriptionJob;if(job.dealId!==dealId)throw new DomainError('录音不存在或当前视角无权访问',404);
    if(['queued','running'].includes(job.status)&&row.remote_id){try{const gateway=speechGateway(environment,origin);if(!gateway)throw new Error();const response=await request(`${gateway.url}/transcriptions/${row.remote_id}`,{headers:{Authorization:`Bearer ${await signRecordingSession(gateway.secret,userId,recordingId)}`},redirect:'manual',signal:AbortSignal.timeout(8000)});if(response.status===404||response.status===410){const expired={...job,status:'failed' as const,message:'语音服务中的任务已过期或被清理，原录音仍保留，请重新转写',updatedAt:new Date().toISOString()};await persist(userId,row,expired);return expired;}if(!response.ok)throw new Error();const remote=remoteJob(await readSpeechJson(response,1950000),job);if(await persist(userId,row,remote.job,remote.remoteId)){row={...row,version:row.version+1,remote_id:remote.remoteId,data_json:JSON.stringify(remote.job)};job=remote.job;}else{const latest=await find(userId,recordingId);if(latest){row=latest;job=JSON.parse(latest.data_json);}}}catch{return {...job,message:'暂时无法读取转写进度；录音已保留，连接恢复后继续查询'};}}
    if(job.status==='queued'&&!row.remote_id&&Date.parse(row.lease_until??'')<=Date.now()){const failed={...job,status:'failed' as const,message:'转写提交未完成；原录音已保存，请重试',updatedAt:new Date().toISOString()};await persist(userId,row,failed);return failed;}
    return link(userId,row,job,origin);
  }
  return {start,read};
}
