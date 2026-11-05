export type ProspectReviewMode = 'manual' | 'automatic';
export type ProspectJobKind = 'discover' | 'collect' | 'send';
export type ProspectJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'unknown' | 'cancelled';
export type ProspectLeadStatus = 'pending' | 'rejected' | 'queued' | 'sending' | 'submitted' | 'failed' | 'unknown' | 'unreachable';
export interface ProspectVideo { id: string; title: string; url: string }
export interface ProspectCandidate {
  id: string; nickname: string; profileUrl: string; description: string;
  reason: string; videos: ProspectVideo[];
}
export interface ProspectCampaign {
  id: string; name: string; requirements: string; keywords: string[];
  reviewMode: ProspectReviewMode; greetingTemplate: string; minIntentScore: number;
  maxCommentsPerVideo: number; dailyLimit: number; status: 'active' | 'paused';
  memberId: string; createdAt: string; updatedAt: string;
  candidates: ProspectCandidate[]; selectedCandidateIds: string[];
}
export interface ProspectComment {
  id: string; videoId: string; videoUrl: string; text: string; nickname: string;
  recipientId?: string; profileUrl?: string; postedAt?: string;
  source: 'browser' | 'mediacrawler';
}
export interface ProspectLead extends ProspectComment {
  campaignId: string; version: number; status: ProspectLeadStatus; intentScore: number;
  reason: string; greeting: string; analysisSource: 'model' | 'rules';
  reviewedBy?: string; reviewedAt?: string; error?: string; updatedAt: string;
}
export interface ProspectJobView {
  id: string; campaignId: string; kind: ProspectJobKind; status: ProspectJobStatus;
  createdAt: string; updatedAt: string; leadId?: string; error?: string; summary?: string;
}
export interface ProspectDeviceView {
  id?: string; label?: string; online: boolean; authenticated: boolean;
  accountId?: string; accountName?: string; lastSeenAt?: string; message?: string;
}
export interface ProspectSnapshot {
  campaigns: ProspectCampaign[]; campaign?: ProspectCampaign; leads: ProspectLead[];
  jobs: ProspectJobView[]; device: ProspectDeviceView; modelReady: boolean;
}
export interface ProspectBridgeJob {
  id: string; campaignId: string; leaseToken: string; kind: ProspectJobKind;
  input: {
    keywords?: string[]; requirements?: string; videos?: ProspectVideo[];
    maxCommentsPerVideo?: number; recipientId?: string; profileUrl?: string;
    message?: string; senderAccountId?: string;
  };
}
export type ProspectBridgeResult =
  | { candidates: ProspectCandidate[] }
  | { comments: ProspectComment[]; warnings?: string[] }
  | { outcome: 'submitted' | 'failed' | 'unknown'; evidence?: string; error?: string };
