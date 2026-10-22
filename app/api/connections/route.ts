import { DomainError } from '../../lib/domain.ts';
import { assertSameOrigin, readConnectionBody } from '../../lib/connection-config.ts';
import { readConnections, writeConnection } from '../../lib/connection-store.ts';
import { requireUserId } from '../../lib/server.ts';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
function failure(error:unknown):Response {
  // Do not echo database errors, provider payloads, URLs, or credentials.
  const message=error instanceof DomainError?error.message:'API 配置暂时不可用，请稍后重试';
  return Response.json({error:message,message},{status:error instanceof DomainError?error.status:503,headers});
}
export async function GET(request:Request):Promise<Response> {
  try {return Response.json(await readConnections(requireUserId(request),new URL(request.url).origin),{headers});}
  catch(error){return failure(error);}
}
export async function POST(request:Request):Promise<Response> {
  try {
    const userId=requireUserId(request);assertSameOrigin(request);
    return Response.json(await writeConnection(userId,await readConnectionBody(request),new URL(request.url).origin),{headers});
  }catch(error){return failure(error);}
}
