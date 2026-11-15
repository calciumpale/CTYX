export const GEO_STATUS_LABELS = {
  draft: '草稿', in_review: '待审核', changes_requested: '待修改', approved: '审核通过', published: '已登记发布',
} as const;
export type GeoStatus = keyof typeof GEO_STATUS_LABELS;

export interface GeoSource { title: string; url: string; excerpt: string }
export interface GeoBrief { brand: string; topic: string; audience: string; question: string; sources: GeoSource[] }
export interface GeoFaq { question: string; answer: string }
export interface GeoArticle { title: string; summary: string; markdown: string; faq: GeoFaq[] }
export interface GeoDocument { brief: GeoBrief; article: GeoArticle }
export interface GeoCheck { id: string; label: string; passed: boolean; detail: string }
export interface GeoQuality { score: number; ready: boolean; checks: GeoCheck[] }
export interface GeoPublication { url: string; channel: string; recordedAt: string }
export interface GeoObservation {
  id: string;
  engine: string;
  query: string;
  result: 'mentioned' | 'not_mentioned' | 'unclear';
  evidence: string;
  recordedAt: string;
}
export const GEO_QUESTION_DIMENSIONS = { category: '品类', scenario: '场景', budget: '预算', competitor: '竞品', after_sales: '售后' } as const;
export const GEO_QUESTION_INTENTS = { awareness: '认知', comparison: '比较', decision: '决策', after_sales: '售后' } as const;
export type GeoQuestionDimension = keyof typeof GEO_QUESTION_DIMENSIONS;
export type GeoQuestionIntent = keyof typeof GEO_QUESTION_INTENTS;
export type GeoPhase = 'baseline' | 'retest';

export interface GeoQuestion { id: string; dimension: GeoQuestionDimension; intent: GeoQuestionIntent; prompt: string }
export interface GeoCitation { title: string; url: string; brandSource: boolean }
export interface GeoCompetitorMention { name: string; count: number }
export interface GeoCaptureSlot {
  questionId: string;
  engine: string;
  phase: GeoPhase;
  sample: number;
}
export interface GeoAnswerInput extends GeoCaptureSlot {
  id: string;
  rawAnswer: string;
  citations: GeoCitation[];
  brandMentions: number;
  brandRank: number | null;
  competitorMentions: GeoCompetitorMention[];
}
export interface GeoAnswerProvenance {
  provider: 'apimart';
  model: string;
  captureId: string;
  requestId?: string;
  webSearch: boolean;
  annotations: 'provider' | 'none';
}
export interface GeoAnswer extends GeoAnswerInput {
  prompt: string;
  intent: GeoQuestionIntent;
  dimension: GeoQuestionDimension;
  brand: string;
  method: 'manual' | 'apimart';
  provenance?: GeoAnswerProvenance;
  recordedAt: string;
}
export type GeoCaptureStatus = 'running' | 'saved' | 'failed' | 'unknown';
export interface GeoCaptureAttempt { id: string; slot: GeoCaptureSlot; sampleKey: string; status: GeoCaptureStatus; startedAt: string; message?: string }
export interface GeoCaptureResponse { project: GeoProject; capture: { status: GeoCaptureStatus; message?: string } }
export interface GeoProviderAnswer { rawAnswer: string; citations: Array<{title: string; url: string}>; model: string; requestId?: string; webSearch: boolean; mentionAnswer?: string }
export interface GeoGap {
  id: string;
  priority: 'P0' | 'P1' | 'P2';
  title: string;
  evidenceAnswerIds: string[];
  action: string;
  expectedImpact: string;
  status: 'open' | 'done';
}
export interface GeoWorkflowPlan { questions: GeoQuestion[]; engines: string[]; repeats: number; competitors: string[] }
export interface GeoWorkflow extends GeoWorkflowPlan { answers: GeoAnswer[]; gaps: GeoGap[]; captureAttempts?: GeoCaptureAttempt[] }

export function emptyGeoWorkflow(): GeoWorkflow {
  return { questions: [], engines: [], repeats: 1, competitors: [], answers: [], gaps: [] };
}

export interface GeoSummary { id: string; topic: string; title: string; status: GeoStatus; updatedAt: string; mine: boolean }
export interface GeoProject {
  id: string;
  version: number;
  updatedAt: string;
  status: GeoStatus;
  document: GeoDocument;
  quality: GeoQuality;
  reviewNote: string;
  publication?: GeoPublication;
  observations: GeoObservation[];
  workflow?: GeoWorkflow;
  canEditWorkflow?: boolean;
  canEdit: boolean;
  canReview: boolean;
  canRecord: boolean;
}

export function emptyGeoDocument(): GeoDocument {
  return {
    brief: { brand: '', topic: '', audience: '', question: '', sources: [] },
    article: { title: '', summary: '', markdown: '', faq: [] },
  };
}
