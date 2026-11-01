import {env} from 'cloudflare:workers';
import {DomainError} from '../../lib/domain.ts';
import {createBusinessSettingsStore} from '../../lib/business-settings.ts';
import {assertSameOrigin,readConnectionBody} from '../../lib/connection-config.ts';
import {assertMemberApi,requireMemberRole} from '../../lib/member-policy.ts';
import {requireUserId} from '../../lib/server.ts';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
const store=()=>createBusinessSettingsStore(env as Cloudflare.Env);
const failure=(error:unknown)=>Response.json({error:error instanceof DomainError?error.message:'业务规则暂时无法读取或保存'},{status:error instanceof DomainError?error.status:503,headers});
export async function GET(request:Request){try{const userId=requireUserId(request);assertMemberApi(requireMemberRole(request),'/api/business-settings','GET');return Response.json(await store().read(userId),{headers});}catch(error){return failure(error);}}
export async function POST(request:Request){try{const userId=requireUserId(request);assertMemberApi(requireMemberRole(request),'/api/business-settings','POST');assertSameOrigin(request);return Response.json(await store().save(userId,await readConnectionBody(request)),{headers});}catch(error){return failure(error);}}
