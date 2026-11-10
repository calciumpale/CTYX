import { env } from 'cloudflare:workers';
import { agentMemorySearchTerms, captureAgentMemory, dreamAgentMemory, recallAgentMemory } from './agent-memory-engine.ts';
import { createAgentMemoryStore } from './agent-memory-store.ts';
import type { MemoryScope, MemoryTranscript } from './agent-memory-types.ts';
import { readEffectiveModel } from './connection-store.ts';
import { DomainError } from './domain.ts';
import { requestModelText } from './model-client.ts';
import type { ModelMessage } from './model-client.ts';

const topicLimit = 24;
const scopeLimit = 4;

/** Stored memory never confers access to a project. Check the live membership. */
export async function canUseAgentMemoryScope(db: D1Database, scope: MemoryScope): Promise<boolean> {
  const member = await db.prepare(`SELECT role, sales_id FROM workbench_member_accounts
    WHERE owner_id = ? AND account_id = ? AND enabled = 1 AND role IN ('sales','manager')`)
    .bind(scope.ownerId, scope.memberId).first<{ role: 'sales' | 'manager'; sales_id: string | null }>();
  if (!member || member.role === 'sales' && !member.sales_id) return false;
  if (!scope.projectId) return true;
  const project = await db.prepare(`SELECT json_extract(deal.value, '$.ownerId') AS owner_id
    FROM workbench_workspaces AS workspace, json_each(workspace.state_json, '$.deals') AS deal
    WHERE workspace.user_id = ? AND json_extract(deal.value, '$.id') = ? LIMIT 1`)
    .bind(scope.ownerId, scope.projectId).first<{ owner_id: string | null }>();
  return !!project && (member.role === 'manager' || project.owner_id === member.sales_id);
}

export function agentMemoryRuntime(siteOrigin: string) {
  const db = (env as Cloudflare.Env).DB;
  if (!db) throw new DomainError('记忆存储尚未连接，请联系管理员。', 503);
  const store = createAgentMemoryStore(db);
  const canUse = (scope: MemoryScope) => canUseAgentMemoryScope(db, scope);

  async function recall(scope: MemoryScope, query: string) {
    if (!await store.isEnabled(scope)) return undefined;
    const terms = [...agentMemorySearchTerms(`${query.slice(-500)} ${query.slice(0, 500)}`)].slice(0, 24);
    const related = async (current: MemoryScope) => (await Promise.all([
      store.findTopics(current, terms, 12), store.topics(current, 12),
    ])).flat();
    const [scoped, personal] = await Promise.all([
      related(scope), scope.projectId ? related({ ...scope, projectId: '' }) : [],
    ]);
    // Prefer the more specific project page when the same topic exists in both scopes.
    const pages = [...new Map([...personal, ...scoped].map(page => [page.topic, page])).values()];
    const memory = recallAgentMemory(query, pages);
    return memory.index.length ? memory : undefined;
  }

  async function capture(scope: MemoryScope, transcript: MemoryTranscript, model: NonNullable<Awaited<ReturnType<typeof readEffectiveModel>>>) {
    if (!await canUse(scope) || !await store.isEnabled(scope)) return;
    const notes = await captureAgentMemory(transcript, messages => requestModelText(model, messages, { timeoutMs: 12_000 }));
    await store.completeCapture(scope, transcript.runId, notes);
  }

  async function dream(scope: MemoryScope) {
    if (!await canUse(scope)) throw new DomainError('当前账号没有此记忆的访问权限。', 403);
    if (!await store.isEnabled(scope)) return;
    const pending = await store.pendingTranscripts(scope, 3);
    const notesBefore = await store.pendingNotes(scope, 12);
    if (!pending.length && !notesBefore.length) return;
    const model = await readEffectiveModel(scope.ownerId, siteOrigin);
    if (!model) throw new DomainError('请先连接大模型，再整理 Agent 记忆。', 503);

    // Deferred capture catches missed requests without slowing down regular replies.
    const captures = await Promise.allSettled(pending.map(transcript => capture(scope, transcript, model)));
    const notes = pending.length ? await store.pendingNotes(scope, 12) : notesBefore;
    if (!notes.length) {
      const failed = captures.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      return;
    }
    const keys = [...new Set(notes.map(note => note.topic))];
    const [recent, related] = await Promise.all([store.topics(scope, topicLimit), store.topicsByKey(scope, keys)]);
    const pages = [...new Map([...related, ...recent].map(page => [page.topic, page])).values()].slice(0, topicLimit);
    const runIds = [...new Set([...notes.map(note => note.runId), ...pages.flatMap(page => page.sourceIds)])];
    const originals = await store.evidenceTranscripts(scope, runIds);
    if (!await canUse(scope) || !await store.isEnabled(scope)) throw new DomainError('当前账号没有此记忆的访问权限。', 403);
    const generate = (messages: ModelMessage[]) => requestModelText(model, messages, { timeoutMs: 20_000 });
    const review = await dreamAgentMemory(notes, originals, pages, generate);
    if (!await canUse(scope)) throw new DomainError('当前账号没有此记忆的访问权限。', 403);
    if (!await store.applyDream(scope, review)) throw new DomainError('记忆已在其他操作中更新，请刷新后重试。', 409);
  }

  async function snapshot(scope: MemoryScope) {
    const [enabled, topics, count] = await Promise.all([store.isEnabled(scope), store.topics(scope, topicLimit), store.pendingCount(scope)]);
    return { enabled, topics, pending: count.transcripts + count.notes };
  }

  async function maintenance() {
    const scopes = (await store.pendingScopes(scopeLimit + 1)).slice(0, scopeLimit + 1);
    let processed = 0, failed = 0;
    let hasMore = scopes.length > scopeLimit;
    await Promise.all(scopes.slice(0, scopeLimit).map(async scope => {
      try {
        if (!await canUse(scope)) return;
        await dream(scope);
        processed++;
        const count = await store.pendingCount(scope);
        if (count.transcripts + count.notes > 0) hasMore = true;
      } catch {
        failed++;
      }
    }));
    return { processed, failed, hasMore };
  }

  return { store, canUse, recall, capture, dream, snapshot, maintenance };
}
