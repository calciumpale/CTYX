import type { WorkbenchState, Deal } from './types.ts';
import type { SalesGenerate, SalesHistoryEntry, SalesIntelligence } from './sales-intelligence-types.ts';
import { analyzeSalesIntelligence, SalesIntelligenceError, salesFingerprint, salesHistoryEntry, salesInput } from './sales-intelligence.ts';

export interface SalesIntelligenceDependencies {
  load: (userId: string, origin: string) => Promise<WorkbenchState>;
  save: (userId: string, expectedRevision: number, state: WorkbenchState) => Promise<void>;
  model?: { name: string } | null;
  generate?: SalesGenerate;
  now?: () => string;
}
type IntelDeal = Deal & { intelligence?: SalesIntelligence };
const conflict = (error: unknown) => error !== null && typeof error === 'object' && 'status' in error && error.status === 409;
function history(result: SalesIntelligence, old?: SalesIntelligence): SalesHistoryEntry[] {
  const values = [...result.history, ...(old?.latest ? [salesHistoryEntry(old.latest)] : []), ...(old?.history ?? [])];
  return [...new Map(values.map(item => [item.sourceHash, item])).keys()].map(hash => values.find(item => item.sourceHash === hash)!).slice(0, 5);
}

/** Call after the business mutation has committed. Only derived state is changed here. */
export async function processSalesIntelligence(userId: string, dealId: string, origin: string, deps: SalesIntelligenceDependencies, options: { force?: boolean } = {}): Promise<WorkbenchState> {
  const clock = deps.now ?? (() => new Date().toISOString());
  let snapshot: WorkbenchState | undefined, sourceHash = '', attemptId = '', snapshotDeal: IntelDeal | undefined;
  for (let retry = 0; retry < 3; retry++) {
    const state = await deps.load(userId, origin), deal = state.deals.find(d => d.id === dealId) as IntelDeal | undefined;
    if (!deal) return state;
    const hash = await salesFingerprint(deal, state.transcripts ?? []), old = deal.intelligence, now = clock();
    if (!options.force && old?.latest?.sourceHash === hash && old.sourceHash === hash && ['ready', 'needs_info'].includes(old.status)) {
      if (old.latest.sourceVersion === deal.version) return state;
      old.latest.sourceVersion = deal.version;
      const expected = state.revision; state.revision++;
      try { await deps.save(userId, expected, state); return state; } catch (error) { if (conflict(error)) continue; throw error; }
    }
    // A duplicate request can reuse an active attempt. A crashed attempt is retryable after two minutes.
    if (!options.force && old?.status === 'processing' && old.sourceHash === hash && Date.parse(now) - Date.parse(old.updatedAt) < 120000) return state;
    attemptId = crypto.randomUUID(); sourceHash = hash;
    deal.intelligence = { status: 'processing', sourceHash: hash, updatedAt: now, modelName: deps.model?.name ?? '', message: '原始资料已保存，正在分析客户意向与成交可能性', attemptId, ...(old?.latest ? { latest: old.latest } : {}), history: (old?.history ?? []).slice(0, 5) };
    const expected = state.revision; state.revision++;
    try { await deps.save(userId, expected, state); snapshot = state; snapshotDeal = deal; break; } catch (error) { if (conflict(error)) continue; throw error; }
  }
  if (!snapshot || !snapshotDeal) return deps.load(userId, origin);
  const now = clock(), input = salesInput(snapshotDeal, snapshot.transcripts ?? []);
  let result: SalesIntelligence;
  const deterministic = input.outcome !== 'open' || input.sources.reduce((n, s) => n + s.text.trim().length, 0) < 40;
  if (!deterministic && (!deps.model || !deps.generate)) {
    result = { status: 'waiting_config', sourceHash, updatedAt: now, modelName: deps.model?.name ?? '', message: '原始资料已保存，请在设置中配置并启用大模型 API 后重新评估', history: [] };
  } else {
    try {
      result = await analyzeSalesIntelligence(snapshotDeal, snapshot.transcripts ?? [], deps.generate ?? (async () => { throw new SalesIntelligenceError(); }), now, deps.model?.name ?? '未调用模型');
    } catch (error) {
      result = { status: 'failed', sourceHash, updatedAt: now, modelName: deps.model?.name ?? '', message: error instanceof SalesIntelligenceError ? error.message : '客户分析暂未完成，原始资料及此前结果已保留，请稍后重试', history: [] };
    }
  }
  for (let retry = 0; retry < 3; retry++) {
    const state = await deps.load(userId, origin), deal = state.deals.find(d => d.id === dealId) as IntelDeal | undefined;
    if (!deal) return state;
    const currentHash = await salesFingerprint(deal, state.transcripts ?? []), current = deal.intelligence;
    if (currentHash !== sourceHash) {
      // Another current attempt or result wins. Never replace it with this older completion or failure.
      if (current?.sourceHash === currentHash && current.attemptId !== attemptId) return state;
      deal.intelligence = { status: 'stale', sourceHash: currentHash, updatedAt: clock(), modelName: current?.modelName ?? '', message: '客户资料在分析期间已更新，此前结果已过期，请重新评估', ...(current?.latest ? { latest: current.latest } : {}), history: (current?.history ?? []).slice(0, 5) };
    } else {
      if (current?.attemptId !== attemptId) return state;
      const latest = result.latest ?? current.latest;
      if (result.latest) result.latest.sourceVersion = deal.version;
      deal.intelligence = { ...result, ...(latest ? { latest } : {}), history: result.latest ? history(result, current) : (current.history ?? []).slice(0, 5) };
    }
    const expected = state.revision; state.revision++;
    try { await deps.save(userId, expected, state); return state; } catch (error) { if (conflict(error)) continue; throw error; }
  }
  return deps.load(userId, origin);
}
