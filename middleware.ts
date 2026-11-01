import {env} from 'cloudflare:workers';
import {NextResponse} from 'next/server';
import {DomainError} from './app/lib/domain.ts';
import {createMemberAuthStore,memberFailure,memberRouteAccess,outerOwnerId,stripMemberHeaders,trustedMemberHeaders} from './app/lib/member-auth.ts';
import {assertMemberRoute} from './app/lib/member-policy.ts';

export async function middleware(request:Request):Promise<Response>{
  const headers=stripMemberHeaders(request.headers);const access=memberRouteAccess(request);
  if(access==='session'||access==='service')return NextResponse.next({request:{headers}});
  try{
    const ownerId=outerOwnerId(request);const member=await createMemberAuthStore({DB:(env as Cloudflare.Env).DB}).authenticate(ownerId,headers.get('cookie'));
    if(!member)throw new DomainError('请先登录工作台',401);
    if(access==='manager'&&member.role!=='manager'||access==='operator'&&member.role==='sales')throw new DomainError('当前账号没有此维护权限',403);
    if(access==='member')assertMemberRoute(request,member.role);
    return NextResponse.next({request:{headers:trustedMemberHeaders(headers,member)}});
  }catch(error){return memberFailure(error);}
}
export const config={matcher:'/api/:path*'};
