import { assertSameOrigin, readConnectionBody } from '../../lib/connection-config.ts';
import { DomainError } from '../../lib/domain.ts';
import { memberResponseHeaders } from '../../lib/member-auth.ts';
import { assertMemberApi, requireMemberRole } from '../../lib/member-policy.ts';
import { readMineruConnection, writeMineruConnection } from '../../lib/mineru-store.ts';
import { requireUserId } from '../../lib/server.ts';

export const dynamic = 'force-dynamic';

function administrator(request: Request): string {
  assertMemberApi(requireMemberRole(request), '/api/mineru-connection', request.method);
  return requireUserId(request);
}

function respond(value: unknown, status = 200) {
  return Response.json(value, { headers: memberResponseHeaders, status });
}

function failure(error: unknown) {
  return error instanceof DomainError
    ? respond({ error: error.message }, error.status)
    : respond({ error: '暂时无法更新 MinerU 配置，请稍后重试。' }, 503);
}

export async function GET(request: Request) {
  try {
    return respond(await readMineruConnection(administrator(request)));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const ownerId = administrator(request);
    assertSameOrigin(request);
    return respond(await writeMineruConnection(ownerId, await readConnectionBody(request)));
  } catch (error) {
    return failure(error);
  }
}
