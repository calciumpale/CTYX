import {DomainError} from '../../lib/domain.ts';
import {requireUserId} from '../../lib/server.ts';
import {requireMemberRole} from '../../lib/member-policy.ts';
import {assertSameOrigin} from '../../lib/connection-config.ts';
import {materialRuntime} from '../../lib/marketing-material-runtime.ts';
import {publicMaterialTask,readMaterialBody} from '../../lib/marketing-material.ts';
import {readEffectiveModel} from '../../lib/connection-store.ts';
export const dynamic='force-dynamic';
export const materialHeaders={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
export function materialIdentity(request:Request){const owner=requireUserId(request);if(requireMemberRole(request)==='admin')throw new DomainError('管理员不能生成业务素材',403);return {owner,member:request.headers.get('x-ctai-member-account-id')!};}
export function materialFailure(error:unknown){const message=error instanceof DomainError?error.message:'素材服务暂时不可用，请稍后重试';return Response.json({error:message,message},{status:error instanceof DomainError?error.status:503,headers:materialHeaders});}
export async function GET(request:Request){try{const {owner,member}=materialIdentity(request),runtime=materialRuntime(new URL(request.url).origin),connection=await runtime.store.connection(owner),model=await readEffectiveModel(owner,new URL(request.url).origin);return Response.json({tasks:(await runtime.store.list(owner,member)).map(publicMaterialTask),availability:{presentation:!!model,image:connection.configured&&connection.enabled&&connection.storageReady&&!!runtime.bucket,video:connection.configured&&connection.enabled&&connection.storageReady&&!!runtime.bucket}},{headers:materialHeaders});}catch(e){return materialFailure(e);}}
export async function POST(request:Request){try{const {owner,member}=materialIdentity(request);assertSameOrigin(request);const body=await readMaterialBody(request);if(!body||typeof body!=='object'||Array.isArray(body))throw new DomainError('素材参数无效');const task=await materialRuntime(new URL(request.url).origin).service.execute(owner,member,body as Record<string,unknown>);return Response.json({task:publicMaterialTask(task)},{headers:materialHeaders});}catch(e){return materialFailure(e);}}
