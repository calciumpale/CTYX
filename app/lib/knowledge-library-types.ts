export const KNOWLEDGE_FILE_LIMIT = 10 * 1024 * 1024;
export const KNOWLEDGE_TEXT_LIMIT = 1_000_000;
export const KNOWLEDGE_CHUNK_LIMIT = 6_000;
export const KNOWLEDGE_SEARCHABLE_LIMIT = 6_000;
export const KNOWLEDGE_REQUEST_LIMIT = 6 * KNOWLEDGE_TEXT_LIMIT + 64 * 1024;
export const KNOWLEDGE_UPLOAD_ACCEPT = '.xlsx,.xls,.pdf,.docx,.txt,.md,.markdown,.csv';

export type KnowledgeChunkStrategy = 'flat' | 'parent-child';
export type KnowledgeRetrievalMode = 'hybrid' | 'bm25' | 'vector';
export type KnowledgeDocumentStatus = 'pending' | 'ready' | 'error';

export interface KnowledgeLibrary {
  id: string;
  name: string;
  documentCount: number;
}

export interface KnowledgeDocument {
  id: string;
  libraryId: string;
  title: string;
  fileName: string;
  strategy: KnowledgeChunkStrategy;
  status: KnowledgeDocumentStatus;
  chunkCount: number;
  indexedCount: number;
  error: string | null;
  updatedAt: string;
}

export interface KnowledgeChunkDraft {
  ordinal: number;
  parentOrdinal: number | null;
  kind: 'flat' | 'parent' | 'child';
  text: string;
  heading: string;
}

export interface KnowledgeChunk extends KnowledgeChunkDraft {
  id: string;
}

export interface KnowledgeHit {
  id: string;
  documentId: string;
  title: string;
  libraryName: string;
  fileName: string;
  heading: string;
  ordinal: number;
  matchedText: string;
  updatedAt: string;
  context: string;
  parent: boolean;
  bm25: number | null;
  vector: number | null;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  mode: KnowledgeRetrievalMode;
  notice: string | null;
}

export interface KnowledgeLibrarySnapshot {
  libraries: KnowledgeLibrary[];
  documents: KnowledgeDocument[];
  canManage: boolean;
  embeddingConfigured: boolean;
}
