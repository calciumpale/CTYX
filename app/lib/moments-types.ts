export const MOMENT_STYLES = { funny: '搞笑', business: '商务', playful: '有趣', warm: '温暖', simple: '简洁' } as const;
export type MomentStyle = keyof typeof MOMENT_STYLES;

export interface MomentPlanInput {
  productName: string;
  productDetails: string;
  style: MomentStyle;
  time: string;
  enabled: boolean;
  includeImage: boolean;
}
export interface MomentPlan extends MomentPlanInput {
  id: string;
  version: number;
  nextRunAt: string | null;
  updatedAt: string;
}
export interface MomentDraft {
  id: string;
  planId: string;
  productName: string;
  style: MomentStyle;
  trigger: 'manual' | 'daily';
  status: 'queued' | 'writing' | 'image_pending' | 'completed' | 'partial' | 'failed';
  text?: string;
  error?: string;
  files: { name: string; type: string; url: string }[];
  createdAt: string;
}
export interface MomentStoredDraft extends MomentDraft {
  ownerId: string;
  memberId: string;
  input: MomentPlanInput;
  imagePrompt?: string;
  imageTaskId?: string;
  version: number;
  updatedAt: string;
  nextCheckAt: string | null;
  leaseToken: string | null;
  leaseUntil: string | null;
}
export interface MomentSnapshot {
  plans: MomentPlan[];
  drafts: MomentDraft[];
  availability: { text: boolean; image: boolean };
}
