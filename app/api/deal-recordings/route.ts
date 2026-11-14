import {readMemberSalesScope} from '../../lib/member-policy.ts';
import {salesMutationEvents} from '../../lib/sales-report-domain.ts';
import { env } from 'cloudflare:workers';
import { DomainError, projectState } from '../../lib/domain.ts';
import { authorizedRecording, parseAudioRange, parseRecordingForm, recordingObjectKey, saveRecordingNote } from '../../lib/followup-recordings.ts';
import { loadWorkspace, readRole, requireUserId, saveWorkspace, refreshSalesProject } from '../../lib/server.ts';
import { createSpeechTranscriptionService } from '../../lib/speech-transcription.ts';
import {readMemberDisplayName} from '../../lib/member-policy.ts';

export const dynamic='force-dynamic';
const responseHeaders={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
function bucket():R2Bucket {
  const store=(env as Cloudflare.Env).BUCKET;
  if(!store)throw new DomainError('录音存储服务尚未就绪，请稍后重试',503);
  return store;
}
function failure(error:unknown):Response {
  if(error instanceof DomainError)return Response.json({error:error.message},{status:error.status,headers:responseHeaders});
  console.error('Follow-up recording request failed',error instanceof Error?error.name:'UnknownError');
  return Response.json({error:'录音暂时无法读取或保存，请稍后重试'},{status:503,headers:responseHeaders});
}
export async function POST(request:Request):Promise<Response> {
  try {
    const userId=requireUserId(request);const siteOrigin=new URL(request.url).origin;
    const origin=request.headers.get('origin');
    if((origin&&origin!==siteOrigin)||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('只允许从当前站点上传录音',403);
    const storage=bucket();const input=await parseRecordingForm(request);const role=readRole(request);
    let before:Awaited<ReturnType<typeof loadWorkspace>>;
    const result=await saveRecordingNote(userId,role,input,{actorName:readMemberDisplayName(request),salesScope:readMemberSalesScope(request),bucket:storage,load:async()=>{before=await loadWorkspace(userId,siteOrigin);return before;},save:(revision,state)=>saveWorkspace(userId,revision,state,salesMutationEvents(before,state,'deal_note',{dealId:input.dealId},new Date().toISOString()))});
    const existing=new Set(before!.deals.find(deal=>deal.id===input.dealId)?.notes.map(note=>note.id));
    const recording=result.state.deals.find(deal=>deal.id===input.dealId)?.notes.find(note=>!existing.has(note.id)&&note.recording)?.recording;
    let transcription:Awaited<ReturnType<ReturnType<typeof createSpeechTranscriptionService>['start']>>|undefined;
    if(recording){try{transcription=await createSpeechTranscriptionService(env as Cloudflare.Env,{load:loadWorkspace,save:saveWorkspace}).start(userId,role,input.dealId,recording.id,siteOrigin,false,readMemberSalesScope(request));}catch{/* A transcription failure never discards the committed recording. */}}
    try{result.state=projectState(await refreshSalesProject(userId,input.dealId,siteOrigin),role,readMemberSalesScope(request));}catch{/* Derivative analysis cannot turn an already saved recording into a failed upload. */}
    return Response.json({...result,...(recording?{recording}:{}),...(transcription?{transcription}:{}),message:transcription?.status==='failed'?`录音及跟进记录已保存；${transcription.message}`:transcription?'录音及跟进记录已保存，转写任务已提交':result.message},{headers:responseHeaders});
  }catch(error){return failure(error);}
}
async function read(request:Request,head=false):Promise<Response> {
  try {
    const userId=requireUserId(request);const url=new URL(request.url);const role=readRole(request);
    const dealId=url.searchParams.get('dealId')??'';const id=url.searchParams.get('id')??'';
    if(!dealId||dealId.length>100)throw new DomainError('录音不存在或当前视角无权访问',404);
    const state=projectState(await loadWorkspace(userId,url.origin),role,readMemberSalesScope(request));
    const recording=authorizedRecording(state,dealId,id);const storage=bucket();const key=await recordingObjectKey(userId,id);
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
