import {assertMemberApi,readMemberSalesScope,requireMemberRole} from '../../lib/member-policy.ts';
import {env} from 'cloudflare:workers';
import {DomainError} from '../../lib/domain.ts';
import {assertSameOrigin,readConnectionBody} from '../../lib/connection-config.ts';
import {loadWorkspace,saveWorkspace,refreshSalesProject,processFeedback,readRole,requireUserId} from '../../lib/server.ts';
import {createSpeechTranscriptionService} from '../../lib/speech-transcription.ts';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
const service=()=>createSpeechTranscriptionService(env as Cloudflare.Env,{load:loadWorkspace,save:saveWorkspace,refresh:refreshSalesProject,feedback:processFeedback});
const failure=(error:unknown)=>Response.json({error:error instanceof DomainError?error.message:'转写任务暂时不可用，请稍后重试；原录音仍已保留'},{status:error instanceof DomainError?error.status:503,headers});
function target(dealId:unknown,recordingId:unknown):{dealId:string;recordingId:string}{if(typeof dealId!=='string'||!dealId||dealId.length>100||typeof recordingId!=='string'||recordingId.length>100)throw new DomainError('录音不存在或当前视角无权访问',404);return {dealId,recordingId};}
function signedIn(request:Request) {
  const userId=requireUserId(request);
  assertMemberApi(requireMemberRole(request),'/api/recording-transcriptions',request.method);
  return {userId,role:readRole(request),salesScope:readMemberSalesScope(request),memberId:request.headers.get('x-ctai-member-account-id')!};
}
export async function GET(request:Request){try{const {userId,role,salesScope,memberId}=signedIn(request),url=new URL(request.url),{dealId,recordingId}=target(url.searchParams.get('dealId'),url.searchParams.get('id'));return Response.json({job:await service().read(userId,role,dealId,recordingId,url.origin,salesScope,memberId)},{headers});}catch(error){return failure(error);}}
export async function POST(request:Request){try{const {userId,role,salesScope,memberId}=signedIn(request);assertSameOrigin(request);const data=await readConnectionBody(request) as Record<string,unknown>;if(!data||!['start','retry'].includes(String(data.action)))throw new DomainError('请选择开始转写或重试');const {dealId,recordingId}=target(data.dealId,data.recordingId);return Response.json({job:await service().start(userId,role,dealId,recordingId,new URL(request.url).origin,data.action==='retry',salesScope,memberId)},{headers});}catch(error){return failure(error);}}
