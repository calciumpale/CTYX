export const STUDIO_KINDS = ['poster', 'web', 'app', 'mini'] as const;
export type StudioKind = typeof STUDIO_KINDS[number];
export const STUDIO_KIND_LABELS: Record<StudioKind, string> = {
  poster: '营销海报', web: '网页', app: 'App', mini: '小程序',
};

/** Geometry uses percentages of the artboard. Font sizes and radii use artboard pixels. */
export interface StudioLayer {
  id: string;
  kind: 'text' | 'image' | 'shape' | 'button';
  name: string;
  text: string;
  assetUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  color: string;
  fontSize: number;
  radius: number;
  weight: 'normal' | 'bold';
  align: 'left' | 'center' | 'right';
}

export interface StudioBoard {
  id: string;
  name: string;
  width: number;
  height: number;
  background: string;
  layers: StudioLayer[];
}

export interface StudioShot {
  visual: string;
  voiceover: string;
  seconds: number;
}

export interface StudioCopy {
  title: string;
  caption: string;
  script: string;
  coverPrompt: string;
  shots: StudioShot[];
}

export interface StudioDocument {
  title: string;
  kind: StudioKind;
  brief: string;
  audience: string;
  channel: string;
  style: string;
  copy: StudioCopy;
  boards: StudioBoard[];
}

export interface StudioSummary {
  id: string;
  title: string;
  kind: StudioKind;
  version: number;
  updatedAt: string;
}

export interface StudioRecord {
  id: string;
  document: StudioDocument;
  version: number;
  updatedAt: string;
}

export interface StudioVersion {
  version: number;
  updatedAt: string;
}

export interface StudioTemplate {
  id: string;
  title: string;
  kind: StudioKind;
  description: string;
  boards: StudioBoard[];
  source: 'builtin' | 'workspace';
  canRemove?: boolean;
}

export type StudioSelection = { boardId: string; layerId?: string } | null;
export interface StudioImage { url: string; name: string }
export type StudioGenerateMode = 'copy' | 'design' | 'revise';
export interface StudioGenerateResult { copy?: StudioCopy; boards?: StudioBoard[] }

export const emptyStudioCopy = (): StudioCopy => ({
  title: '', caption: '', script: '', coverPrompt: '', shots: [],
});
