import { waitUntil } from 'cloudflare:workers';
import { acceptsChatProgress, CHAT_PROGRESS_CONTENT_TYPE, createChatProgressStream, type ChatProgressStep } from '../../lib/chat-progress.ts';
import { DomainError } from '../../lib/domain.ts';
import {readSalesOwners,loadWorkspace,mutateWorkbench,readRole,requireUserId} from '../../lib/server.ts';
import {assertMemberAction,readMemberSalesScope,projectAccountResult,projectAccountState,readMemberDisplayName,requireMemberRole} from '../../lib/member-policy.ts';

export const dynamic='force-dynamic';
const responseHeaders={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id, Accept','X-Content-Type-Options':'nosniff'};
const MAX_BODY=512*1024;
function describeError(error:unknown):{error:string;status:number;outcomeUnknown?:boolean} {
  if(error instanceof DomainError)return {error:error.message,status:error.status};
  console.error('Workbench API request failed',error instanceof Error?error.name:'UnknownError');
  return {error:'暂时无法读取或保存体验空间，请稍后重试',status:500,outcomeUnknown:true};
}
function errorResponse(failure:unknown):Response {
  const {error,status}=describeError(failure);
  return Response.json({error},{status,headers:responseHeaders});
}
async function body(request:Request):Promise<Record<string,unknown>> {
  if(!request.headers.get('content-type')?.toLowerCase().includes('application/json'))throw new DomainError('请使用JSON格式提交请求',415);
  if(Number(request.headers.get('content-length')??0)>MAX_BODY)throw new DomainError('请求过大，请缩减内容后重试',413);
  const reader=request.body?.getReader();if(!reader)throw new DomainError('请求内容不能为空');
  const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();throw new DomainError('请求过大，请缩减内容后重试',413);}chunks.push(value);}
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let position=0;for(const chunk of chunks){bytes.set(chunk,position);position+=chunk.byteLength;}
  let parsed:unknown;try {parsed=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new DomainError('JSON请求格式不正确');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new DomainError('请求参数格式不正确');
  return parsed as Record<string,unknown>;
}
export async function GET(request:Request):Promise<Response> {
  try {const role=requireMemberRole(request),userId=requireUserId(request);const state=projectAccountState(role,await loadWorkspace(userId,new URL(request.url).origin),readMemberSalesScope(request));if(role==='manager')state.salesOwners=await readSalesOwners(userId);return Response.json(state,{headers:responseHeaders});}catch(error){return errorResponse(error);}
}
export async function POST(request:Request):Promise<Response> {
  try {
    const userId=requireUserId(request);const origin=request.headers.get('origin');const siteOrigin=new URL(request.url).origin;
    if((origin&&origin!==siteOrigin)||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('只允许从当前站点发起操作',403);
    const input=await body(request);
    const action=input.action;
    if(typeof action!=='string')throw new DomainError('缺少操作名称');
    const payload=input.payload??{};
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new DomainError('操作参数格式不正确');
    if(action==='switch_role')throw new DomainError('账号角色由登录权限确定，请退出后使用对应账号登录',403);
    const memberRole=requireMemberRole(request);
    const role=readRole(request);
    const memberName=readMemberDisplayName(request);
    const salesScope=readMemberSalesScope(request);
    const memberId=request.headers.get('x-ctai-member-account-id')!;
    const parameters=payload as Record<string,unknown>;
    const execute=async(onProgress?: (step:ChatProgressStep)=>void)=>{
      const result=await mutateWorkbench(userId,role,action,parameters,input.revision,siteOrigin,memberRole,memberName,salesScope,memberId,onProgress);
      const projected=projectAccountResult(memberRole,result,salesScope);
      if(memberRole==='manager')projected.state.salesOwners=await readSalesOwners(userId);
      return projected;
    };
    if(action==='chat'&&acceptsChatProgress(request.headers.get('accept'))){
      assertMemberAction(memberRole,action,parameters);
      const stream=createChatProgressStream(execute,describeError,waitUntil);
      return new Response(stream,{headers:{...responseHeaders,'Cache-Control':'private, no-store, no-transform',
        'Content-Type':CHAT_PROGRESS_CONTENT_TYPE+'; charset=utf-8','X-Accel-Buffering':'no'}});
    }
    return Response.json(await execute(),{headers:responseHeaders});
  } catch(error){return errorResponse(error);}
}
