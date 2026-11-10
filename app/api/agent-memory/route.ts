import { agentMemoryRuntime } from '../../lib/agent-memory-runtime.ts';
import { assertSameOrigin } from '../../lib/connection-config.ts';
import { DomainError } from '../../lib/domain.ts';
import { memberResponseHeaders, readMemberBody } from '../../lib/member-auth.ts';
import { assertMemberApi, requireMemberRole } from '../../lib/member-policy.ts';
import { requireUserId } from '../../lib/server.ts';

export const dynamic = 'force-dynamic';

function respond(value: unknown, status = 200) {
  return Response.json(value, { headers: memberResponseHeaders, status });
}

function failure(error: unknown) {
  if (error instanceof DomainError) return respond({ error: error.message }, error.status);
  console.error('Agent memory request failed', error instanceof Error ? error.name : 'UnknownError');
  return respond({ error: '暂时无法读取或整理 Agent 记忆，请稍后重试。' }, 503);
}

async function context(request: Request, project: unknown) {
  const url = new URL(request.url);
  assertMemberApi(requireMemberRole(request), url.pathname, request.method);
  if (project != null && (typeof project !== 'string' || !/^[A-Za-z0-9_.:-]{1,150}$/.test(project))) throw new DomainError('项目编号不正确。');
  const scope = { ownerId: requireUserId(request), memberId: request.headers.get('x-ctai-member-account-id')!, projectId: typeof project === 'string' ? project : '' };
  const runtime = agentMemoryRuntime(url.origin);
  if (!await runtime.canUse(scope)) throw new DomainError('当前账号没有此记忆的访问权限。', 403);
  return { runtime, scope };
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const { runtime, scope } = await context(request, params.get('projectId'));
    const topic = params.get('topic');
    if (topic !== null) {
      if (!topic.trim() || topic.length > 160) throw new DomainError('记忆主题不正确。');
      const page = await runtime.store.topic(scope, topic);
      if (!page) throw new DomainError('这个记忆主题已更新或移除。', 404);
      const originals = await runtime.store.transcripts(scope, page.sourceIds);
      return respond({ sources: originals.map(({ runId, query, createdAt }) => ({ runId, query, createdAt })) });
    }
    return respond(await runtime.snapshot(scope));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = await readMemberBody(request);
    const { runtime, scope } = await context(request, input.projectId);
    switch (input.action) {
      case 'setEnabled':
        if (typeof input.enabled !== 'boolean') throw new DomainError('请选择是否启用记忆。');
        await runtime.store.setEnabled(scope, input.enabled);
        break;
      case 'dream':
        await runtime.dream(scope);
        break;
      case 'forgetTopic':
        if (typeof input.topic !== 'string' || !input.topic.trim() || input.topic.length > 160 || typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 1) throw new DomainError('记忆主题或版本不正确。');
        if (!await runtime.store.forgetTopic(scope, input.topic, input.version)) throw new DomainError('记忆主题已更新，请刷新后重试。', 409);
        break;
      default: throw new DomainError('请选择有效的记忆操作。');
    }
    return respond(await runtime.snapshot(scope));
  } catch (error) {
    return failure(error);
  }
}
