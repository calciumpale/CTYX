import type { Deal, WorkbenchState } from './types.ts';

/** Public provenance never changes when a human starts recording business evidence. */
export const SALES_BUSINESS_FIELDS = ['name','projectName','contact','position','industry','source','website','region','amount','priority','deadline','nextAction','summary','needs','risks','customerProfile','ownerId','owner'] as const;
export function salesReportEligible(deal: Deal): boolean {
  return deal.dataOrigin === 'manual' || deal.dataOrigin === 'research' && !!deal.businessRecordedAt && Number.isFinite(Date.parse(deal.businessRecordedAt));
}
export function currentSalesProject(deal: Deal): boolean {
  return !deal.archive && salesReportEligible(deal);
}

export function publicSourceLabel(deal: Deal): string {
  return salesReportEligible(deal) ? '公开来源 · 已有人工业务记录' : '公开线索 · 待开发';
}

/** Trusted canonical writers call this only after a successful delta, before the shared workspace CAS. */
export function markSalesBusinessChanges(original: WorkbenchState, next: WorkbenchState, now: string): void {
  for (const deal of next.deals) {
    const previous = original.deals.find(item => item.id === deal.id);
    if (deal.dataOrigin !== 'research' || deal.businessRecordedAt || previous?.dataOrigin !== 'research') continue;
    const fields = [...SALES_BUSINESS_FIELDS, 'stage', 'outcome'] as const;
    const noteIds = new Set(previous.notes.map(note => note.id));
    const transcriptIds = new Set((original.transcripts ?? []).filter(item => item.dealId === deal.id).map(item => item.id));
    if (fields.some(key => JSON.stringify(previous[key]) !== JSON.stringify(deal[key])) || deal.notes.some(note => !note.recording?.sourceOnly && !noteIds.has(note.id)) || (next.transcripts ?? []).some(item => item.dealId === deal.id && !transcriptIds.has(item.id))) deal.businessRecordedAt = now;
  }
}
