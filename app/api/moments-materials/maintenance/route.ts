import { assertSameOrigin } from '../../../lib/connection-config.ts';
import { DomainError } from '../../../lib/domain.ts';
import { readMemberBody } from '../../../lib/member-auth.ts';
import { momentRuntime } from '../../../lib/moments-runtime.ts';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** The owner-private Sites gateway validates the unattended access token.
 * This route accepts only a cookie-free service request and never a supplied owner. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (request.headers.has('oai-authenticated-user-id') || request.headers.has('oai-authenticated-user-email') || request.headers.has('cookie')) {
      throw new DomainError('需要站点定时服务授权', 403);
    }
    if (Object.keys(await readMemberBody(request)).length) throw new DomainError('朋友圈定时任务不接受参数');
    return Response.json(await momentRuntime(new URL(request.url).origin).maintenance(), { headers });
  } catch (error) {
    return Response.json({ error: error instanceof DomainError ? error.message : '朋友圈定时任务未完成' }, {
      status: error instanceof DomainError ? error.status : 503, headers,
    });
  }
}
