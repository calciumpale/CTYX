import { env } from 'cloudflare:workers';
import { DomainError } from '../../lib/domain.ts';
import { readRole, readWorkbench, requireUserId } from '../../lib/server.ts';
import { gatewayConfiguration, signVoiceSession } from '../../lib/voice-session.ts';
import {createSpeechSettingsStore} from '../../lib/speech-settings.ts';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
function failure(error:unknown):Response {
  return Response.json({error:error instanceof Error?error.message:'暂时无法连接语音服务'},{status:error instanceof DomainError?error.status:503,headers});
}
export async function GET(request:Request):Promise<Response> {
  try {
    requireUserId(request);
    const configuration=gatewayConfiguration(env as Cloudflare.Env,new URL(request.url).origin);
    return Response.json({configured:!!configuration,message:configuration?'自部署网关已配置，连接后检查实时状态':'尚未连接自部署语音网关'},{headers});
  } catch(error){return failure(error);}
}
export async function POST(request:Request):Promise<Response> {
  try {
    const userId=requireUserId(request);const origin=request.headers.get('origin');
    if((origin&&origin!==new URL(request.url).origin)||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('只允许从当前站点连接语音服务',403);
    if(!request.headers.get('content-type')?.includes('application/json'))throw new DomainError('请使用JSON格式提交请求',415);
    // Stream with a hard ceiling; Content-Length is not trusted.
    const reader=request.body?.getReader();if(!reader)throw new DomainError('缺少会话参数');
    const chunks:Uint8Array[]=[];let length=0;
    try {while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>4096){await reader.cancel();throw new DomainError('会话参数过大',413);}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
    let input:unknown;try{input=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new DomainError('会话参数格式不正确');}
    const sessionId=input&&typeof input==='object'&&!Array.isArray(input)?(input as Record<string,unknown>).sessionId:undefined;
    if(typeof sessionId!=='string'||sessionId.length>128)throw new DomainError('请选择有效的带练会话');
    const state=await readWorkbench(userId,readRole(request),new URL(request.url).origin);
    const session=state.trainingSessions.find(item=>item.id===sessionId);
    if(!session)throw new DomainError('当前视角无法访问此带练会话',403);
    if(session.status!=='active')throw new DomainError('本次带练已结束，请开始新的练习',409);
    const configuration=gatewayConfiguration(env as Cloudflare.Env,new URL(request.url).origin);
    if(!configuration)throw new DomainError('自部署语音网关尚未配置，请先按部署说明启动服务',503);
    const words=(await createSpeechSettingsStore(env as Cloudflare.Env).read(userId)).hotwords;
    return Response.json({url:configuration.url,token:await signVoiceSession(configuration.secret,userId,sessionId,Math.floor(Date.now()/1000),words),outputSampleRate:24000,voices:[],defaultVoice:''},{headers});
  }catch(error){return failure(error);}
}
