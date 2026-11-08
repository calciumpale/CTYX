import { DomainError } from '../../lib/domain.ts';
import { assertSameOrigin, readConnectionBody } from '../../lib/connection-config.ts';
import { webProspectRuntime } from '../../lib/web-prospect-runtime.ts';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie, oai-authenticated-user-id', 'X-Content-Type-Options': 'nosniff' };
function failure(e: unknown) { return Response.json({ error: e instanceof DomainError ? e.message : '公开搜索暂时不可用，请稍后重试' }, { status: e instanceof DomainError ? e.status : 503, headers }); }
export async function GET(request: Request) { try {
    const { actor, store, owners } = await webProspectRuntime(request);
    await store.expire(actor.ownerId, actor.memberId);
    return Response.json({ ...await store.snapshot(actor.ownerId, actor.memberId), owners }, { headers });
}
catch (e) {
    return failure(e);
} }
export async function POST(request: Request) { try {
    assertSameOrigin(request);
    const body = await readConnectionBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new DomainError('搜索参数无效');
    const { actor, service, owners } = await webProspectRuntime(request);
    return Response.json({ ...await service.execute(actor, body as Record<string, unknown>), owners }, { headers });
}
catch (e) {
    return failure(e);
} }
