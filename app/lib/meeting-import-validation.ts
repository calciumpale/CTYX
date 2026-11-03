import {DomainError} from './domain.ts';
import type {WorkbenchState,Deal} from './types.ts';
import type {MemberSession} from './member-types.ts';
import type {MeetingRecord,MeetingBridgeImportResult} from './meeting-import-types.ts';

export const MAX_MEETING_SOURCE_BYTES=900_000;
export const MAX_MEETING_AUDIO_BYTES=50*1024*1024;
export const meetingHeaders={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
export const meetingHash=async(value:string):Promise<string>=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
export const meetingToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export function sameMeetingSecret(a:string,b:string):boolean{let n=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)n|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return n===0;}
export function meetingId(value:unknown,label='标识'):string{
 if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(value))throw new DomainError(`${label}不正确`);return value;
}
export function assertMeetingProject(state:WorkbenchState,actor:MemberSession,dealId:string):Deal{
 const deal=state.deals.find(x=>x.id===dealId);
 if(actor.role==='admin'||!deal||actor.role==='sales'&&(!actor.salesId||actor.salesId!==deal.ownerId))throw new DomainError('当前账号无权访问此项目',403);
 return deal;
}
export function visibleMeetingDeals(state:WorkbenchState,actor:MemberSession):string[]{return actor.role==='admin'?[]:state.deals.filter(x=>actor.role==='manager'||actor.salesId&&x.ownerId===actor.salesId).map(x=>x.id);}
export function validateMeetingRecord(value:unknown,allowPending=false):MeetingRecord{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('会议文件信息不正确');
 const r=value as Record<string,unknown>;const pending=allowPending&&r.recordFileId===''&&['recording','transcoding','unavailable'].includes(String(r.state));const recordFileId=pending?'':meetingId(r.recordFileId,'录制文件');
 const text=(v:unknown,max:number)=>typeof v==='string'?v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(0,max):'';
 if(!['audio','video','unknown'].includes(String(r.kind)))throw new DomainError('会议媒体类型不正确');
 const meetingRecordId=meetingId(r.meetingRecordId,'录制');
 return {key:pending?`pending-${meetingRecordId}`:recordFileId,recordFileId,meetingRecordId,subject:text(r.subject,300)||'未命名会议',state:text(r.state,100)||'unknown',kind:r.kind as MeetingRecord['kind'],...(r.meetingId?{meetingId:meetingId(r.meetingId)}:{}),...(typeof r.meetingCode==='string'&&/^\d{3,20}$/.test(r.meetingCode)?{meetingCode:r.meetingCode}:{}),...(typeof r.startedAt==='string'&&Number.isFinite(Date.parse(r.startedAt))?{startedAt:r.startedAt}:{})};
}
export function validateMeetingSource(value:unknown,allowAudioOnly=false):MeetingBridgeImportResult{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError('会议内容格式不正确');const r=value as Record<string,unknown>;
 if(typeof r.minutes!=='string'||typeof r.transcript!=='string'||typeof r.complete!=='boolean'||!Array.isArray(r.warnings))throw new DomainError('会议内容缺少完整性信息');
 const minutes=r.minutes.trim(),transcript=r.transcript.trim();
 if(!minutes&&!transcript&&!allowAudioOnly)throw new DomainError('没有取得会议正文或录音，请核实录制权限和生成状态');
 if(new TextEncoder().encode(minutes+'\n'+transcript).byteLength>MAX_MEETING_SOURCE_BYTES)throw new DomainError('会议正文过长，请分段导入',413);
 return{minutes,transcript,complete:r.complete,warnings:r.warnings.filter((x):x is string=>typeof x==='string').slice(0,20).map(x=>x.slice(0,500))};
}
export async function readMeetingBody(request:Request,max=16_384):Promise<Record<string,unknown>>{
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw new DomainError('请提交JSON内容',415);
 const reader=request.body?.getReader();if(!reader)throw new DomainError('请求内容为空');let n=0;const out:Uint8Array[]=[];
 try{for(;;){const v=await reader.read();if(v.done)break;n+=v.value.byteLength;if(n>max){await reader.cancel();throw new DomainError('请求内容过大',413);}out.push(v.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(n);let at=0;for(const x of out){bytes.set(x,at);at+=x.length;}
 try{const result=JSON.parse(new TextDecoder().decode(bytes));if(!result||typeof result!=='object'||Array.isArray(result))throw new Error();return result;}catch{throw new DomainError('请求格式不正确');}
}
export function meetingFailure(error:unknown):Response{return Response.json({error:error instanceof DomainError?error.message:'会议服务暂时不可用，已保存的内容不会丢失'},{status:error instanceof DomainError?error.status:503,headers:meetingHeaders});}
