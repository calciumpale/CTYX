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
