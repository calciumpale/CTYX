import { env } from 'cloudflare:workers';
import { assertSameOrigin } from '../../lib/connection-config.ts';
import { DomainError } from '../../lib/domain.ts';
import { requestEmbeddings } from '../../lib/embedding-client.ts';
import { effectiveEmbedding } from '../../lib/embedding-store.ts';
import { splitKnowledgeText } from '../../lib/knowledge-library-chunks.ts';
import { knowledgeModelKey } from '../../lib/knowledge-library-runtime.ts';
import { createKnowledgeLibraryStore } from '../../lib/knowledge-library-store.ts';
import { KNOWLEDGE_REQUEST_LIMIT, KNOWLEDGE_TEXT_LIMIT } from '../../lib/knowledge-library-types.ts';
import { readMeetingBody as readJsonObject } from '../../lib/meeting-import-validation.ts';
import { assertKnowledgeLibraryAction, assertMemberApi, requireMemberRole } from '../../lib/member-policy.ts';
import { requireUserId } from '../../lib/server.ts';

export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'private, no-store',
  'Vary': 'Cookie, oai-authenticated-user-id',
  'X-Content-Type-Options': 'nosniff',
};

function respond(data: unknown, status = 200) {
  return Response.json(data, { headers, status });
}

function failure(error: unknown) {
  if (error instanceof DomainError) return respond({ error: error.message }, error.status);
  console.error('Knowledge library request failed', error instanceof Error ? error.name : 'UnknownError');
  return respond({ error: '资料库暂时不可用，请稍后重试' }, 503);
}

function context(request: Request) {
  const ownerId = requireUserId(request);
  const role = requireMemberRole(request);
  const url = new URL(request.url);
  assertMemberApi(role, url.pathname, request.method);
  const db = (env as Cloudflare.Env).DB;
  if (!db) throw new DomainError('资料库数据库尚未连接', 503);
  return { ownerId, role, url, store: createKnowledgeLibraryStore(db, ownerId) };
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError(`请填写${name}`);
  const cleaned = value.trim();
  if (cleaned.length > max) throw new DomainError(`${name}不能超过 ${max.toLocaleString('zh-CN')} 字`, 413);
  return cleaned;
}

export async function GET(request: Request) {
  try {
    const { ownerId, role, url, store } = context(request);
    const documentId = url.searchParams.get('documentId');
    if (documentId !== null) {
      return respond({ chunks: await store.chunks(text(documentId, '文档编号', 100)) });
    }
    const connection = await effectiveEmbedding(ownerId).catch(() => null);
    return respond({
      ...await store.snapshot(connection ? knowledgeModelKey(connection) : null),
      canManage: role !== 'sales',
      embeddingConfigured: Boolean(connection),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const { ownerId, role, url, store } = context(request);
    assertSameOrigin(request);
    const input = await readJsonObject(request, KNOWLEDGE_REQUEST_LIMIT);
    const action = text(input.action, '操作名称', 40);
    assertKnowledgeLibraryAction(role, action);
    switch (action) {
      case 'createLibrary':
        return respond({ library: await store.createLibrary(text(input.name, '资料库名称', 60)) }, 201);
      case 'renameLibrary':
        await store.renameLibrary(text(input.libraryId, '资料库编号', 100), text(input.name, '资料库名称', 60));
        return respond({});
      case 'upload': {
        const { strategy } = input;
        if (strategy !== 'flat' && strategy !== 'parent-child') throw new DomainError('请选择切块策略');
        const libraryId = text(input.libraryId, '资料库编号', 100);
        const title = text(input.title, '文档标题', 150);
        const fileName = input.fileName ? text(input.fileName, '文件名', 255) : title;
        const content = text(input.text, '文档正文', KNOWLEDGE_TEXT_LIMIT);
        const chunks = splitKnowledgeText(content, strategy);
        if (!chunks.length) throw new DomainError('文档未提取到可检索的文字');
        return respond({ document: await store.addDocument({ libraryId, title, fileName, strategy, chunks }) }, 201);
      }
      case 'index': {
        const documentId = text(input.documentId, '文档编号', 100);
        const connection = await effectiveEmbedding(ownerId);
        if (!connection) throw new DomainError('请在设置中启用 Embedding，文档仍可进行关键词检索', 409);
        const document = await store.indexDocument(documentId, knowledgeModelKey(connection), async (texts) =>
          (await requestEmbeddings(connection, texts, { origin: url.origin, timeoutMs: 20_000 })).vectors,
        );
        return respond({ document });
      }
      case 'removeDocument':
        await store.removeDocument(text(input.documentId, '文档编号', 100));
        return respond({});
      case 'search': {
        const query = text(input.query, '检索内容', 1_500);
        const { mode } = input;
        if (mode !== 'hybrid' && mode !== 'bm25' && mode !== 'vector') throw new DomainError('请选择检索方式');
        const libraryId = input.libraryId ? text(input.libraryId, '资料库编号', 100) : undefined;
        const connection = mode === 'bm25' ? null : await effectiveEmbedding(ownerId).catch(() => null);
        return respond(await store.search({
          query, libraryId, mode,
          ...(connection ? {
            modelKey: knowledgeModelKey(connection),
            embed: async () => (await requestEmbeddings(connection, [query], { origin: url.origin, timeoutMs: 8_000 })).vectors[0],
          } : {}),
        }));
      }
      default:
        throw new DomainError('此资料库操作暂不可用');
    }
  } catch (error) {
    return failure(error);
  }
}
