import {env} from 'cloudflare:workers';
import {DomainError} from '../../lib/domain.ts';
import {assertMemberOrigin,createMemberAuthStore,memberFailure,memberResponseHeaders,outerOwnerId,readMemberBody} from '../../lib/member-auth.ts';

export const dynamic='force-dynamic';
const store=()=>createMemberAuthStore({DB:(env as Cloudflare.Env).DB});
async function actor(request:Request){const ownerId=outerOwnerId(request);const auth=store();const member=await auth.authenticate(ownerId,request.headers.get('cookie'));if(!member)throw new DomainError('请先登录工作台',401);return {auth,ownerId,member};}
export async function GET(request:Request):Promise<Response>{try{const {auth,ownerId,member}=await actor(request);return Response.json({members:await auth.list(ownerId,member)},{headers:memberResponseHeaders});}catch(error){return memberFailure(error);}}
export async function PATCH(request:Request):Promise<Response>{try{const {auth,ownerId,member}=await actor(request);assertMemberOrigin(request);return Response.json({members:await auth.update(ownerId,member,await readMemberBody(request))},{headers:memberResponseHeaders});}catch(error){return memberFailure(error);}}
export const POST=PATCH;
