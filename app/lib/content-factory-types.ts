import type { StudioBoard } from './creative-studio-types.ts';

export const FACTORY_CHANNELS = {
  wechat: '公众号长文',
  xiaohongshu: '小红书笔记',
  email: '邮件 EDM',
  sms: '短信',
  poster: '海报配图',
  video: '视频号脚本',
} as const;
export const FACTORY_GOALS = { leads: '线索获取', awareness: '品牌种草', retention: '老客唤醒', invite: '活动邀约' } as const;
export const FACTORY_TONES = { professional: '专业顾问 · 温和', conversational: '轻松口语 · 年轻', conversion: '直接明确 · 促转化' } as const;
export type FactoryChannel = keyof typeof FACTORY_CHANNELS;
export type FactoryTextChannel = Exclude<FactoryChannel, 'poster'>;
export type FactoryGoal = keyof typeof FACTORY_GOALS;
export type FactoryTone = keyof typeof FACTORY_TONES;

export interface FactoryBrief {
  goal: FactoryGoal;
  topic: string;
  audience: string;
  tone: FactoryTone;
  channels: FactoryChannel[];
  requirements: string;
  brand: string;
}

export interface FactoryCopy {
  channel: FactoryTextChannel;
  title: string;
  alternateTitle: string;
  body: string;
}

export interface FactoryAudience {
  summary: string;
  tags: string[];
  nextStep: string;
}

export interface FactoryGeneration {
  copy: FactoryCopy[];
  posters: StudioBoard[];
  audience: FactoryAudience | null;
  generatedAt: string;
}

export interface FactoryQueueItem {
  id: string;
  channel: FactoryChannel;
  assetId: string;
  title: string;
  body: string;
  poster?: StudioBoard;
  status: 'review' | 'scheduled' | 'draft' | 'approved';
  scheduledAt: string;
}

export interface FactoryDocument {
  brief: FactoryBrief;
  generated: FactoryGeneration | null;
  queue: FactoryQueueItem[];
}

export interface FactoryRecord {
  id: string;
  version: number;
  updatedAt: string;
  document: FactoryDocument;
}

export const blankFactoryDocument = (): FactoryDocument => ({
  brief: { goal: 'leads', topic: '', audience: '', tone: 'professional', channels: ['wechat', 'xiaohongshu'], requirements: '', brand: '' },
  generated: null,
  queue: [],
});
