import type { KnowledgeChunkConfig } from '../lib/knowledge-chunking-config';
import type { KnowledgeDocument } from '../lib/knowledge-library-types';
export type KnowledgePdfParser = 'browser' | 'mineru';
export type ImportQueueItem = { id: string; file: File; libraryId: string; config: KnowledgeChunkConfig; rebuildIndex: boolean; parser: KnowledgePdfParser; state: 'queued' | 'working' | 'done' | 'error'; text?: string; warnings?: string[]; document?: KnowledgeDocument; error?: string; mineruTicket?: string; progress?: string };
export async function drainImportQueue(items: ImportQueueItem[], stopped: () => boolean, process: (item: ImportQueueItem) => Promise<void | 'paused'>, changed: () => void) {
  async function worker() {
    while (!stopped()) {
      const item = items.find(row => row.state === 'queued');
      if (!item) return;
      item.state = 'working'; item.error = undefined; changed();
      try { item.state = await process(item) === 'paused' ? 'queued' : 'done'; }
      catch (error) { item.state = 'error'; item.error = error instanceof Error ? error.message : '导入未完成'; }
      changed();
    }
  }
  await Promise.all([worker(), worker()]);
}
