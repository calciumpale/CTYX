import { agentMemoryRuntime } from '../../../lib/agent-memory-runtime.ts';
import { assertSameOrigin } from '../../../lib/connection-config.ts';
import { DomainError } from '../../../lib/domain.ts';
import { readMemberBody } from '../../../lib/member-auth.ts';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** Only unattended requests authorized by the owner-private Sites gateway. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (request.headers.has('oai-authenticated-user-id') || request.headers.has('oai-authenticated-user-email') || request.headers.has('cookie')) throw new DomainError('需要站点定时服务授权。', 403);
    if (Object.keys(await readMemberBody(request)).length) throw new DomainError('Agent 记忆定时整理不接受参数。');
    return Response.json(await agentMemoryRuntime(new URL(request.url).origin).maintenance(), { headers });
  } catch (error) {
    const status = error instanceof DomainError ? error.status : 503;
    return Response.json({ error: error instanceof DomainError ? error.message : 'Agent 记忆定时整理未完成。' }, { status, headers });
  }
}
