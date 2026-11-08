import type { KnowledgeDocument, KnowledgeRechunkJob } from '../lib/knowledge-library-types.ts';
export type RechunkResult = { document: KnowledgeDocument; job: KnowledgeRechunkJob };
export function documentWithRechunkJob(result: RechunkResult): KnowledgeDocument {
 const { rechunkJob: _previous, ...document } = result.document;
 void _previous;
 return { ...document, ...(['completed','cancelled'].includes(result.job.status) ? {} : { rechunkJob: result.job }) };
}
/** Each gesture has a finite request budget. A leased/no-progress response yields to the user. */
export async function driveRechunk(initial: RechunkResult, advance: (jobId: string) => Promise<RechunkResult>, observe: (result: RechunkResult) => void, paused: () => boolean = () => false, retryError = false) {
 let current = initial; observe(current);
 for (let batch = 0; batch < 8; batch++) {
  if (current.job.status === 'completed' || current.job.status === 'cancelled' || current.job.status === 'error' && !(retryError && batch === 0)) return { ...current, reason: current.job.status };
  if (paused()) return { ...current, reason: 'paused' as const };
  const previous = current.job;
  current = await advance(previous.id); observe(current);
  if (['completed','cancelled','error'].includes(current.job.status)) return { ...current, reason: current.job.status };
  if (current.job.indexedCount <= previous.indexedCount && current.job.status === previous.status) return { ...current, reason: 'waiting' as const };
 }
 return { ...current, reason: 'paused' as const };
}
