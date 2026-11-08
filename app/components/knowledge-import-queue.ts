import type { KnowledgeChunkConfig } from '../lib/knowledge-chunking-config';
import type { KnowledgeDocument } from '../lib/knowledge-library-types';
export type ImportQueueItem = { id: string; file: File; libraryId: string; config: KnowledgeChunkConfig; rebuildIndex: boolean; state: 'queued' | 'working' | 'done' | 'error'; text?: string; warnings?: string[]; document?: KnowledgeDocument; error?: string };
export async function drainImportQueue(items: ImportQueueItem[], stopped: () => boolean, process: (item: ImportQueueItem) => Promise<void>, changed: () => void) {
  async function worker() {
    while (!stopped()) {
      const item = items.find(row => row.state === 'queued');
      if (!item) return;
      item.state = 'working'; changed();
      try { await process(item); item.state = 'done'; }
      catch (error) { item.state = 'error'; item.error = error instanceof Error ? error.message : '导入未完成'; }
      changed();
    }
  }
  await Promise.all([worker(), worker()]);
}
