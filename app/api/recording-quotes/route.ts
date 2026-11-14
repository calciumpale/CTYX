import { env } from 'cloudflare:workers';
import { assertSameOrigin } from '../../lib/connection-config.ts';
import { DomainError } from '../../lib/domain.ts';
import { assertMemberApi, readMemberSalesScope, requireMemberRole } from '../../lib/member-policy.ts';
import { recordingQuoteStore } from '../../lib/recording-quotes.ts';
import { readRole, readWorkbench, requireUserId } from '../../lib/server.ts';
import { readSpeechJson } from '../../lib/speech-settings.ts';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie, oai-authenticated-user-id', 'X-Content-Type-Options': 'nosniff' };

async function store(request: Request) {
  const user = requireUserId(request);
  const role = requireMemberRole(request);
  assertMemberApi(role, '/api/recording-quotes', request.method);
  const db = (env as Cloudflare.Env).DB;
  if (!db) throw new DomainError('金句存储暂时不可用，请稍后重试。', 503);
  const state = await readWorkbench(user, readRole(request), new URL(request.url).origin, readMemberSalesScope(request));
  return recordingQuoteStore(db, { ownerId: user, memberId: request.headers.get('x-ctai-member-account-id')!, manager: role === 'manager', state });
}

function failed(error: unknown) {
  if (error instanceof DomainError) return Response.json({ error: error.message }, { status: error.status, headers });
  console.error('Recording quote operation failed', error instanceof Error ? error.name : 'UnknownError');
  return Response.json({ error: '金句操作暂时失败，请稍后重试。' }, { status: 503, headers });
}

export async function GET(request: Request) {
  try {
    return Response.json(await (await store(request)).list(new URL(request.url).searchParams.get('cursor')), { headers });
  } catch (error) { return failed(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const quotes = await store(request);
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new DomainError('请使用 JSON 提交金句。', 415);
    let input: unknown;
    try { input = await readSpeechJson(new Response(request.body), 4096); }
    catch (error) { throw new DomainError('金句请求格式不正确或超出长度限制。', error instanceof DomainError && error.status === 413 ? 413 : 400); }
    return Response.json({ quote: await quotes.save(input) }, { headers });
  } catch (error) { return failed(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    await (await store(request)).remove(new URL(request.url).searchParams.get('id'));
    return Response.json({ ok: true }, { headers });
  } catch (error) { return failed(error); }
}
