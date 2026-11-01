import { env } from 'cloudflare:workers';
import { DomainError } from '../../lib/domain.ts';
import { assertApprovalOrigin, createApprovalService, readApprovalIdentity } from '../../lib/approval-service.ts';
import { readRole } from '../../lib/server.ts';
import type { ApprovalListOptions } from '../../lib/approval-store.ts';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id, oai-authenticated-user-email, oai-authenticated-user-full-name','X-Content-Type-Options':'nosniff'};
const MAX_BODY=256*1024;
function service(){const db=(env as Cloudflare.Env).DB;if(!db)throw new DomainError('审批数据库尚未连接，请稍后重试',503);return createApprovalService(db);}
function errorResponse(error:unknown):Response {
  if(error instanceof DomainError)return Response.json({error:error.message},{status:error.status,headers});
  console.error('Approval API request failed',error instanceof Error?error.name:'UnknownError');
  return Response.json({error:'暂时无法读取或保存审批，请稍后重试'},{status:500,headers});
}
async function body(request:Request):Promise<Record<string,unknown>> {
  if(!request.headers.get('content-type')?.toLowerCase().includes('application/json'))throw new DomainError('请使用JSON格式提交请求',415);
  const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY))throw new DomainError('请求过大，请缩减内容后重试',413);
  const reader=request.body?.getReader();if(!reader)throw new DomainError('请求内容不能为空');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();throw new DomainError('请求过大，请缩减内容后重试',413);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let result:unknown;try{result=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new DomainError('JSON请求格式不正确');}
  if(!result||typeof result!=='object'||Array.isArray(result))throw new DomainError('请求参数格式不正确');return result as Record<string,unknown>;
}
export async function GET(request:Request):Promise<Response>{
  try{
    const actor=readApprovalIdentity(request);assertApprovalOrigin(request);const params=new URL(request.url).searchParams,id=params.get('id');
    if(params.get('scope')==='templates'){
      if([...params.keys()].some(key=>key!=='scope'))throw new DomainError('审批流程查询参数无效');
      return Response.json(await service().templates(actor),{headers});
    }
    if(id)return Response.json(await service().detail(actor,id),{headers});
    const options:ApprovalListOptions={};for(const field of ['projectId','q','status','cursor'] as const){const value=params.get(field);if(value)options[field]=value;}
    const scope=params.get('scope');if(scope){if(!['inbox','mine','all'].includes(scope))throw new DomainError('审批列表范围无效');options.scope=scope as ApprovalListOptions['scope'];}
    const limit=params.get('limit');if(limit){if(!/^\d+$/.test(limit))throw new DomainError('每页数量应为1至50');options.limit=Number(limit);}
    return Response.json(await service().list(actor,options),{headers});
  }catch(error){return errorResponse(error);}
}
export async function POST(request:Request):Promise<Response>{
  try{
    const actor=readApprovalIdentity(request);assertApprovalOrigin(request);const input=await body(request);
    if(Object.keys(input).some(key=>key!=='action'&&key!=='payload')||typeof input.action!=='string')throw new DomainError('请检查审批操作参数');
    if(!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload))throw new DomainError('审批操作参数格式不正确');
    return Response.json(await service().mutate(actor,readRole(request),input.action,input.payload as Record<string,unknown>),{headers});
  }catch(error){return errorResponse(error);}
}
