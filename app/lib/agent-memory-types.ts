export interface MemoryScope {
  ownerId: string;
  memberId: string;
  projectId: string;
}

export interface MemoryTranscript {
  runId: string;
  query: string;
  answer: string;
  createdAt: string;
  trace?: string;
}

export interface MemoryNote {
  id: string;
  runId: string;
  kind: 'preference' | 'practice' | 'correction';
  topic: string;
  title: string;
  text: string;
  quote: string;
  createdAt: string;
}

export interface MemoryTopic {
  topic: string;
  title: string;
  body: string;
  sourceIds: string[];
  updatedAt: string;
  version: number;
}

export interface MemoryDream {
  examinedNoteIds: string[];
  upsert: MemoryTopic[];
  remove: { topic: string; version: number }[];
}

export interface AgentMemoryContext {
  index: string[];
  topics: { title: string; body: string }[];
}
