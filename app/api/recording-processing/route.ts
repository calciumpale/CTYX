import { env } from 'cloudflare:workers';
import { assertSameOrigin } from '../../lib/connection-config.ts';
import { readEffectiveModel } from '../../lib/connection-store.ts';
import { DomainError } from '../../lib/domain.ts';
import { assertMemberApi, readMemberSalesScope, requireMemberRole } from '../../lib/member-policy.ts';
import { requestModelText } from '../../lib/model-client.ts';
import { createRecordingProcessing } from '../../lib/recording-processing.ts';
import { loadWorkspace, readRole, requireUserId } from '../../lib/server.ts';
import { readSpeechJson } from '../../lib/speech-settings.ts';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, oai-authenticated-user-id', 'X-Content-Type-Options': 'nosniff' };

async function scope(request: Request) {
  const ownerId = requireUserId(request);
  assertMemberApi(requireMemberRole(request), '/api/recording-processing', request.method);
  const db = (env as Cloudflare.Env).DB;
  if (!db) throw new DomainError('录音整理存储暂时不可用，请稍后重试。', 503);
  const origin = new URL(request.url).origin;
  const context = { ownerId, memberId: request.headers.get('x-ctai-member-account-id')!, role: readRole(request), salesScope: readMemberSalesScope(request) };
  return { store: createRecordingProcessing(db), context, origin, state: await loadWorkspace(ownerId, origin) };
}

function failure(error: unknown) {
  if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status, headers });
  console.error('Recording processing request failed', error instanceof Error ? error.name : 'UnknownError');
  return Response.json({ error: '录音整理暂时失败，请稍后重试。' }, { status: 503, headers });
}

export async function GET(request: Request) {
  try {
    const { store, context, state } = await scope(request);
    const params = new URL(request.url).searchParams;
    const status = await store.read(context, state, {
      dealId: params.get('dealId'), recordingId: params.get('recordingId'), jobId: params.get('jobId'), targetDealId: params.get('targetDealId'),
    });
    return Response.json(status, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { store, context, state, origin } = await scope(request);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new DomainError('请使用 JSON 提交录音整理。', 415);
    let input: unknown;
    try { input = await readSpeechJson(new Response(request.body), 4096); }
    catch (error) { throw new DomainError('录音整理参数格式不正确或超出长度限制。', error instanceof DomainError && error.status === 413 ? 413 : 400); }
    const draft = await store.generate(context, state, input, async messages => {
      const model = await readEffectiveModel(context.ownerId, origin);
      if (!model) throw new DomainError('大模型当前不可用，请核对服务连接后重试。', 503);
      return requestModelText(model, messages, { timeoutMs: 60000 });
    });
    return Response.json({ draft }, { headers });
  } catch (error) { return failure(error); }
}
