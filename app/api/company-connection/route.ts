import { DomainError } from '../../lib/domain.ts';
import { assertSameOrigin, readConnectionBody } from '../../lib/connection-config.ts';
import { readCompanyConnection, writeCompanyConnection } from '../../lib/company-connection.ts';
import { requireUserId } from '../../lib/server.ts';
import { assertMemberApi, requireMemberRole } from '../../lib/member-policy.ts';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
function failure(error:unknown){const message=error instanceof DomainError?error.message:'企业数据配置暂时不可用，请稍后重试';return Response.json({error:message},{status:error instanceof DomainError?error.status:503,headers});}
function provider(value:unknown):'qcc'|'jinghai' {
  if(value===undefined||value===null||value==='qcc')return 'qcc';
  if(value==='jinghai')return 'jinghai';
  throw new DomainError('请选择支持的企业数据服务');
}
export async function GET(request:Request){
  try{
    const userId=requireUserId(request);
    assertMemberApi(requireMemberRole(request),'/api/company-connection','GET');
    return Response.json(await readCompanyConnection(userId,provider(new URL(request.url).searchParams.get('provider'))),{headers});
  }catch(error){return failure(error);}
}
export async function POST(request:Request){
  try{
    const userId=requireUserId(request);
    assertMemberApi(requireMemberRole(request),'/api/company-connection','POST');
    assertSameOrigin(request);
    const input=await readConnectionBody(request);
    if(!input||typeof input!=='object'||Array.isArray(input))throw new DomainError('企业数据配置格式不正确');
    const body=input as Record<string,unknown>;
    return Response.json(await writeCompanyConnection(userId,body,provider(body.provider)),{headers});
  }catch(error){return failure(error);}
}
