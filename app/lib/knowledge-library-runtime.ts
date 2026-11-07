import { effectiveEmbedding } from './embedding-store.ts';
import { requestEmbeddings, type EmbeddingConnection } from './embedding-client.ts';
import { createKnowledgeLibraryStore } from './knowledge-library-store.ts';
import type { Knowledge } from './types.ts';

export function knowledgeModelKey(connection: EmbeddingConnection): string {
  return JSON.stringify([connection.url, connection.name]);
}

export async function workbenchKnowledge(
  db: D1Database,
  ownerId: string,
  origin: string,
  query: string,
  options?: { libraryIds: string[] },
): Promise<Knowledge[]> {
  try {
    if (options && !options.libraryIds.length) return [];
    const text = query.trim().slice(-1_500);
    if (!text) return [];
    const connection = await effectiveEmbedding(ownerId).catch(() => null);
    const { hits } = await createKnowledgeLibraryStore(db, ownerId).search({
      query: text,
      mode: 'hybrid',
      limit: 4,
      ...(options ? { libraryIds: options.libraryIds } : {}),
      ...(connection ? {
        modelKey: knowledgeModelKey(connection),
        embed: async () => (await requestEmbeddings(connection, [text], { origin, timeoutMs: 4_500 })).vectors[0],
      } : {}),
    });
    return hits.map(hit => ({
      id: `knowledge-document:${hit.id}`,
      title: [hit.title, hit.heading].filter(Boolean).join(' · '),
      category: hit.libraryName,
      content: hit.context,
      source: [hit.libraryName, hit.fileName || hit.title].join(' / '),
      status: 'published',
      updatedAt: hit.updatedAt,
    }));
  } catch (error) {
    console.warn('Managed knowledge retrieval unavailable', error instanceof Error ? error.name : 'UnknownError');
    return [];
  }
}
