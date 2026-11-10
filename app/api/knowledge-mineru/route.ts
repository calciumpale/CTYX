import { env } from 'cloudflare:workers';
import { assertSameOrigin, encryptionReady } from '../../lib/connection-config.ts';
import { DomainError } from '../../lib/domain.ts';
import { createMineruTicket, readMineruTicket, readMineruUpload } from '../../lib/knowledge-mineru.ts';
import { readMeetingBody } from '../../lib/meeting-import-validation.ts';
import { memberResponseHeaders } from '../../lib/member-auth.ts';
import { assertMemberApi, requireMemberRole } from '../../lib/member-policy.ts';
import { pollMineruPdf, submitMineruPdf } from '../../lib/mineru-client.ts';
import { readEffectiveMineruToken } from '../../lib/mineru-store.ts';
import { requireUserId } from '../../lib/server.ts';

export const dynamic = 'force-dynamic';

function respond(data: unknown, status = 200) {
  return Response.json(data, { headers: memberResponseHeaders, status });
}

function failure(error: unknown) {
  if (error instanceof DomainError) return respond({ error: error.message }, error.status);
  console.error('Knowledge MinerU request failed', error instanceof Error ? error.name : 'UnknownError');
  return respond({ error: 'MinerU 云解析暂时不可用，请稍后重试。' }, 503);
}

function context(request: Request) {
  const role = requireMemberRole(request);
  assertMemberApi(role, new URL(request.url).pathname, request.method);
  return {
    identity: { ownerId: requireUserId(request), memberId: request.headers.get('x-ctai-member-account-id')! },
    key: (env as Cloudflare.Env).CONFIG_ENCRYPTION_KEY,
  };
}

export async function GET(request: Request) {
  try {
    const { identity, key } = context(request);
    return respond({ configured: encryptionReady(key) && Boolean(await readEffectiveMineruToken(identity.ownerId)) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const { identity, key } = context(request);
    assertSameOrigin(request);
    if (!encryptionReady(key)) throw new DomainError('MinerU 云解析尚未配置，请联系管理员。', 503);
    const token = await readEffectiveMineruToken(identity.ownerId);
    if (!token) throw new DomainError('请管理员先在「服务连接」中配置 MinerU API Token。', 503);

    if (request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      const { ticket } = await readMeetingBody(request, 4096);
      const batchId = await readMineruTicket(ticket, key, identity);
      return respond(await pollMineruPdf(token, batchId));
    }

    const file = await readMineruUpload(request);
    const batchId = await submitMineruPdf(token, file);
    const ticket = await createMineruTicket(batchId, key, identity);
    return respond({ ticket }, 202);
  } catch (error) {
    return failure(error);
  }
}
