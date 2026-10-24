import {DomainError} from '../../../lib/domain.ts';
import {assertSameOrigin} from '../../../lib/connection-config.ts';
import {readRole,requireUserId,runTalkMaintenance} from '../../../lib/server.ts';
export const dynamic='force-dynamic';
/** Access must remain owner-private. Shared/public deployments require a separate service credential. */
export async function POST(request:Request){try{assertSameOrigin(request);const visitor=request.headers.get('oai-authenticated-user-id');if(visitor&&readRole(request)!=='manager')throw new DomainError('需要销售管理者权限',403);const result=await runTalkMaintenance(new URL(request.url).origin,visitor?requireUserId(request):undefined);return Response.json(result,{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:e instanceof DomainError?e.message:'维护暂时未完成'},{status:e instanceof DomainError?e.status:503});}}
