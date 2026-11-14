import {assertMemberApi, readMemberDisplayName, readMemberSalesScope, requireMemberRole} from '../../lib/member-policy.ts';
import {salesMutationEvents} from '../../lib/sales-report-domain.ts';
import { env } from 'cloudflare:workers';
import { DomainError, projectState } from '../../lib/domain.ts';
import { authorizedRecording, parseAudioRange, parseRecordingForm, recordingObjectKey, saveRecordingNote } from '../../lib/followup-recordings.ts';
import { loadWorkspace, readRole, requireUserId, saveWorkspace, refreshSalesProject } from '../../lib/server.ts';
import { createSpeechTranscriptionService } from '../../lib/speech-transcription.ts';
import { listRecordingInbox, readRecordingInboxSource, saveRecordingInboxSource } from '../../lib/recording-inbox.ts';
import { RECORDING_INBOX_DEAL_ID } from '../../lib/recording-inbox-types.ts';
import type { FollowupRecording, Role } from '../../lib/types.ts';
import type { SalesScope } from '../../lib/sales-scope.ts';

export const dynamic='force-dynamic';
const responseHeaders={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
function bucket():R2Bucket {
  const store=(env as Cloudflare.Env).BUCKET;
  if(!store)throw new DomainError('录音存储服务尚未就绪，请稍后重试',503);
  return store;
}
function database():D1Database {
  const db=(env as Cloudflare.Env).DB;
  if(!db)throw new DomainError('个人录音存储暂时不可用，请稍后重试',503);
  return db;
}
async function startTranscription(userId:string,role:Role,dealId:string,recording:FollowupRecording,origin:string,salesScope?:SalesScope,memberId?:string) {
  try{return await createSpeechTranscriptionService(env as Cloudflare.Env,{load:loadWorkspace,save:saveWorkspace}).start(userId,role,dealId,recording.id,origin,false,salesScope,memberId);}
  catch{/* A transcription failure never discards the committed recording. */}
}
function savedMessage(saved:string,transcription:Awaited<ReturnType<typeof startTranscription>>) {
  return transcription?.status==='failed'?`${saved}；${transcription.message}`:transcription?.status==='completed'?`${saved}，转写已完成`:transcription?`${saved}，转写任务已提交`:saved;
}
function failure(error:unknown):Response {
  if(error instanceof DomainError)return Response.json({error:error.message},{status:error.status,headers:responseHeaders});
  console.error('Follow-up recording request failed',error instanceof Error?error.name:'UnknownError');
  return Response.json({error:'录音暂时无法读取或保存，请稍后重试'},{status:503,headers:responseHeaders});
}
export async function POST(request:Request):Promise<Response> {
  try {
    const userId=requireUserId(request);const siteOrigin=new URL(request.url).origin;
    assertMemberApi(requireMemberRole(request),'/api/deal-recordings',request.method);
    const origin=request.headers.get('origin');
    if((origin&&origin!==siteOrigin)||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('只允许从当前站点上传录音',403);
    const storage=bucket();const input=await parseRecordingForm(request);const role=readRole(request);
    const salesScope=readMemberSalesScope(request);
    const memberId=request.headers.get('x-ctai-member-account-id')!;
    if(input.dealId===RECORDING_INBOX_DEAL_ID){
      const state=projectState(await loadWorkspace(userId,siteOrigin),role,salesScope);
      const {recording,createdAt}=await saveRecordingInboxSource(database(),userId,memberId,input.audio,storage);
      const transcription=await startTranscription(userId,role,input.dealId,recording,siteOrigin,salesScope,memberId);
      return Response.json({state,recording,recordingCreatedAt:createdAt,...(transcription?{transcription}:{}),message:savedMessage('原录音已保存',transcription)},{headers:responseHeaders});
    }
    let before:Awaited<ReturnType<typeof loadWorkspace>>;
    const result=await saveRecordingNote(userId,role,input,{actorName:readMemberDisplayName(request),salesScope,bucket:storage,load:async()=>{before=await loadWorkspace(userId,siteOrigin);return before;},save:(revision,state)=>saveWorkspace(userId,revision,state,input.sourceOnly?[]:salesMutationEvents(before,state,'deal_note',{dealId:input.dealId},new Date().toISOString()))});
    const existing=new Set(before!.deals.find(deal=>deal.id===input.dealId)?.notes.map(note=>note.id));
    const recording=result.state.deals.find(deal=>deal.id===input.dealId)?.notes.find(note=>!existing.has(note.id)&&note.recording)?.recording;
    const transcription=recording?await startTranscription(userId,role,input.dealId,recording,siteOrigin,salesScope):undefined;
    if(!input.sourceOnly)try{result.state=projectState(await refreshSalesProject(userId,input.dealId,siteOrigin),role,salesScope);}catch{/* Derivative analysis cannot turn an already saved recording into a failed upload. */}
    const saved=input.sourceOnly?'原录音已保存':'录音及跟进记录已保存';
    return Response.json({...result,...(recording?{recording}:{}),...(transcription?{transcription}:{}),message:savedMessage(saved,transcription)},{headers:responseHeaders});
  }catch(error){return failure(error);}
}
async function read(request:Request,head=false):Promise<Response> {
  try {
    const userId=requireUserId(request);const url=new URL(request.url);const role=readRole(request);
    assertMemberApi(requireMemberRole(request),'/api/deal-recordings',request.method);
    const memberId=request.headers.get('x-ctai-member-account-id')!;
    if(!head&&url.searchParams.get('inbox')==='1'){
      const id=url.searchParams.get('id');
      const page=id===null?await listRecordingInbox(database(),userId,memberId,url.searchParams.get('cursor')):
        {recordings:[await readRecordingInboxSource(database(),userId,memberId,id)],nextCursor:null};
      return Response.json(page,{headers:responseHeaders});
    }
    const dealId=url.searchParams.get('dealId')??'';const id=url.searchParams.get('id')??'';
    if(!dealId||dealId.length>100)throw new DomainError('录音不存在或当前视角无权访问',404);
    const recording=dealId===RECORDING_INBOX_DEAL_ID?(await readRecordingInboxSource(database(),userId,memberId,id)).recording:
      authorizedRecording(projectState(await loadWorkspace(userId,url.origin),role,readMemberSalesScope(request)),dealId,id);
    const storage=bucket();const key=await recordingObjectKey(userId,id);
    const metadata=await storage.head(key);
    if(!metadata||metadata.size!==recording.size)throw new DomainError('录音不存在或暂时无法读取',404);
    const headers=new Headers({...responseHeaders,'Content-Type':recording.mimeType,'Accept-Ranges':'bytes','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(recording.name)}`});
    const rangeHeader=request.headers.get('range');let range:{offset:number;length:number}|undefined;
    if(rangeHeader) {
      try{range=parseAudioRange(rangeHeader,metadata.size);}catch(error){if(error instanceof DomainError&&error.status===416){headers.set('Content-Range',`bytes */${metadata.size}`);return new Response(null,{status:416,headers});}throw error;}
      headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${metadata.size}`);
    }
    headers.set('Content-Length',String(range?.length??metadata.size));
    if(head)return new Response(null,{status:range?206:200,headers});
    const object=await storage.get(key,range?{range}:undefined);
    if(!object)throw new DomainError('录音不存在或暂时无法读取',404);
    return new Response(object.body,{status:range?206:200,headers});
  }catch(error){const response=failure(error);return head?new Response(null,{status:response.status,headers:response.headers}):response;}
}
export async function GET(request:Request):Promise<Response> {return read(request);}
export async function HEAD(request:Request):Promise<Response> {return read(request,true);}
