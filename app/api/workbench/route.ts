import { DomainError } from '../../lib/domain.ts';
import { mutateWorkbench, readRole, readWorkbench, requireUserId, roleCookie } from '../../lib/server.ts';
import type { Role } from '../../lib/types.ts';

export const dynamic='force-dynamic';
const responseHeaders={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
const MAX_BODY=512*1024;
function errorResponse(error:unknown):Response {
  if(error instanceof DomainError)return Response.json({error:error.message},{status:error.status,headers:responseHeaders});
  console.error('Workbench API request failed',error instanceof Error?error.name:'UnknownError');
  return Response.json({error:'暂时无法读取或保存体验空间，请稍后重试'},{status:500,headers:responseHeaders});
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
  try {return Response.json(await readWorkbench(requireUserId(request),readRole(request)),{headers:responseHeaders});}catch(error){return errorResponse(error);}
}
export async function POST(request:Request):Promise<Response> {
  try {
    const userId=requireUserId(request);const origin=request.headers.get('origin');
    if((origin&&origin!==new URL(request.url).origin)||request.headers.get('sec-fetch-site')==='cross-site')throw new DomainError('只允许从当前站点发起操作',403);
    const input=await body(request);
    if(typeof input.action!=='string')throw new DomainError('缺少操作名称');
    const payload=input.payload??{};
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new DomainError('操作参数格式不正确');
    if(input.action==='switch_role') {
      const role=(payload as Record<string,unknown>).role;
      if(role!=='sales'&&role!=='manager')throw new DomainError('体验视角不正确');
      return Response.json({state:await readWorkbench(userId,role as Role),message:`已切换${role==='sales'?'销售':'销售管理者'}体验视角`},{headers:{...responseHeaders,'Set-Cookie':roleCookie(role as Role,request)}});
    }
    const result=await mutateWorkbench(userId,readRole(request),input.action,payload as Record<string,unknown>,input.revision);
    return Response.json(result,{headers:responseHeaders});
  } catch(error){return errorResponse(error);}
}
