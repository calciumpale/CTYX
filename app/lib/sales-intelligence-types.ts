export type SalesGrade = 'A' | 'B' | 'C';
export type SalesDimensionKey = 'need' | 'budget' | 'decision' | 'timeline' | 'engagement';
export type SalesConfidence = 'low' | 'medium' | 'high';
export interface SalesEvidence { refId: string; quote: string; }
export interface SalesSource { id: string; kind: 'project' | 'profile' | 'note' | 'transcript'; label: string; text: string; at?: string; }
export interface SalesInput {
  dealId: string; companyName: string; projectName: string; stage: string;
  dataOrigin: 'sample' | 'manual'; outcome: 'open' | 'won' | 'lost';
  sources: SalesSource[]; warnings: string[];
  coverage: { notes: number; transcripts: number; includedNotes: number; includedTranscripts: number; truncated: boolean };
}
export interface SalesNextAction { action: string; reason: string; evidence: SalesEvidence[]; }
export interface SalesDimension { key: SalesDimensionKey; score: number | null; max: number; reason: string; evidence: SalesEvidence[]; }
export interface SalesFactor { direction: 'positive' | 'negative'; reason: string; evidence: SalesEvidence[]; }
export interface SalesAssessment {
  sourceHash: string; sourceVersion: number; assessedAt: string; modelName: string;
  insight: { score: number | null; grade: SalesGrade | null; summary: string; dimensions: SalesDimension[]; nextActions: SalesNextAction[]; missingInfo: string[] };
  forecast: { kind: 'estimated' | 'observed' | 'unknown'; probability: number | null; range: { low: number; high: number } | null; confidence: SalesConfidence | null; summary: string; factors: SalesFactor[]; nextActions: SalesNextAction[] };
  warnings: string[];
}
export interface SalesHistoryEntry { sourceHash: string; assessedAt: string; modelName: string; score: number | null; grade: SalesGrade | null; probability: number | null; forecastKind: SalesAssessment['forecast']['kind']; summary: string; }
export interface SalesIntelligence {
  status: 'ready' | 'needs_info' | 'waiting_config' | 'failed' | 'processing' | 'stale';
  /** The input attempted most recently. Compare latest.sourceHash to current input before displaying it as current. */
  sourceHash: string; updatedAt: string; modelName: string; message: string;
  attemptId?: string;
  latest?: SalesAssessment; history: SalesHistoryEntry[];
}
export type SalesGenerate = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<string>;
