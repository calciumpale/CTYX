import {env} from 'cloudflare:workers';
import {DomainError} from '../../lib/domain.ts';
import {assertMemberOrigin,clearMemberCookie,createMemberAuthStore,memberCookie,memberFailure,memberResponseHeaders,outerOwnerId,readMemberBody} from '../../lib/member-auth.ts';

export const dynamic='force-dynamic';
const store=()=>createMemberAuthStore({DB:(env as Cloudflare.Env).DB});
export async function GET(request:Request):Promise<Response>{
  try{const ownerId=outerOwnerId(request);const member=await store().authenticate(ownerId,request.headers.get('cookie'));return Response.json(member?{authenticated:true,member}:{authenticated:false},{headers:memberResponseHeaders});}catch(error){return memberFailure(error);}
}
export async function POST(request:Request):Promise<Response>{
  try{
    const ownerId=outerOwnerId(request);assertMemberOrigin(request);const input=await readMemberBody(request);
    if(Object.keys(input).some(key=>!['username','password'].includes(key)))throw new DomainError('登录参数不正确');
    const result=await store().login(ownerId,input.username,input.password,request.headers.get('cookie'));
    return Response.json({member:result.member},{headers:{...memberResponseHeaders,'Set-Cookie':memberCookie(result.token,request)}});
  }catch(error){return memberFailure(error);}
}
export async function DELETE(request:Request):Promise<Response>{
  try{const ownerId=outerOwnerId(request);assertMemberOrigin(request);await store().logout(ownerId,request.headers.get('cookie'));return Response.json({authenticated:false},{headers:{...memberResponseHeaders,'Set-Cookie':clearMemberCookie(request)}});}catch(error){return memberFailure(error);}
}
