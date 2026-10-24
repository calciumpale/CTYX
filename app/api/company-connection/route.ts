import { DomainError } from '../../lib/domain.ts';
import { assertSameOrigin, readConnectionBody } from '../../lib/connection-config.ts';
import { readCompanyConnection, writeCompanyConnection } from '../../lib/company-connection.ts';
import { requireUserId } from '../../lib/server.ts';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, oai-authenticated-user-id','X-Content-Type-Options':'nosniff'};
function failure(error:unknown){const message=error instanceof DomainError?error.message:'企查查配置暂时不可用，请稍后重试';return Response.json({error:message},{status:error instanceof DomainError?error.status:503,headers});}
export async function GET(request:Request){try{return Response.json(await readCompanyConnection(requireUserId(request)),{headers});}catch(error){return failure(error);}}
export async function POST(request:Request){try{const userId=requireUserId(request);assertSameOrigin(request);return Response.json(await writeCompanyConnection(userId,await readConnectionBody(request)),{headers});}catch(error){return failure(error);}}
