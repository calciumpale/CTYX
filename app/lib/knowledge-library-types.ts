import type {KnowledgeChunkConfig} from './knowledge-chunking-config.ts';
import type {KnowledgeLibraryDepartment} from './knowledge-department-scope.ts';
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
  defaultConfig?: KnowledgeChunkConfig;
  version?: number;
  departmentId?: KnowledgeLibraryDepartment;
}

export interface KnowledgeDocument {
  id: string;
  libraryId: string;
  contentVersion?: number;
  sourceAvailable?: boolean;
  appliedConfig?: KnowledgeChunkConfig;
  rechunkJob?: KnowledgeRechunkJob;
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

export interface KnowledgeRechunkJob {
 id:string;documentId:string;config:KnowledgeChunkConfig;baseVersion:number;status:'indexing'|'ready'|'error'|'completed'|'cancelled';chunkCount:number;indexedCount:number;error:string|null;createdAt:string;updatedAt:string;
}
export interface KnowledgeChunkPreview {config:KnowledgeChunkConfig;totalChunks:number;searchableChunks:number;parentChunks:number;samples:KnowledgeChunkDraft[];sourceAvailable:boolean;contentVersion?:number}
