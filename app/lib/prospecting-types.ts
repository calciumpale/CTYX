export interface ProspectDailyDiscovery { enabled:boolean; time:string; timeZone:'Asia/Shanghai'; includeNewCandidates:true; nextRunAt?:string }
export interface ProspectDiscoveryRun { id:string; trigger:'daily'|'manual'; scheduledFor:string; status:'queued'|'discovering'|'collecting'|'completed'|'partial'|'failed'|'cancelled'; startedAt?:string; finishedAt?:string; discoveredAccounts:number; newAccounts:number; readComments:number; newComments:number; newLeads:number; pendingJobs:number; completedJobs:number; totalJobs:number; error?:string }
export type ProspectReviewMode = 'manual' | 'automatic';
export type ProspectJobKind = 'discover' | 'collect' | 'send' | 'readConversation' | 'reply';
export type ProspectJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'unknown' | 'cancelled';
export type ProspectLeadStatus = 'pending' | 'rejected' | 'queued' | 'sending' | 'submitted' | 'failed' | 'unknown' | 'unreachable';
export interface ProspectVideo { id: string; title: string; url: string }
export interface ProspectCandidate {
  firstSeenAt?:string; firstRunId?:string;
  id: string; nickname: string; profileUrl: string; description: string;
  reason: string; videos: ProspectVideo[];
}
export interface ProspectCampaign {
  dailyDiscovery?:ProspectDailyDiscovery;
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
  firstSeenAt?:string; firstRunId?:string;
  campaignId: string; version: number; status: ProspectLeadStatus; intentScore: number;
  reason: string; greeting: string; analysisSource: 'model' | 'rules';
  reviewedBy?: string; reviewedAt?: string; error?: string; updatedAt: string;
}
export interface ProspectJobView {
  id: string; campaignId: string; kind: ProspectJobKind; status: ProspectJobStatus;
  createdAt: string; updatedAt: string; leadId?: string; error?: string; summary?: string; warnings?: string[];
}
export interface ProspectDeviceView {
  id?: string; label?: string; online: boolean; authenticated: boolean;
  accountId?: string; accountName?: string; lastSeenAt?: string; message?: string;
}
export interface ProspectSnapshot {
  discoveryRuns?:ProspectDiscoveryRun[]; leadPagination?:{page:number;pageSize:number;total:number};
  campaigns: ProspectCampaign[]; campaign?: ProspectCampaign; leads: ProspectLead[];
  jobs: ProspectJobView[]; device: ProspectDeviceView; modelReady: boolean;
}
export interface ProspectBridgeJob {
  id: string; campaignId: string; leaseToken: string; kind: ProspectJobKind;
  input: {
    keywords?: string[]; requirements?: string; videos?: ProspectVideo[];
    maxCommentsPerVideo?: number; recipientId?: string; profileUrl?: string;
    message?: string; senderAccountId?: string;
    retry?: { previousJobId: string; checkSince?: string };
    conversationId?: string; limit?: number; replyId?: string;
    expectedSnapshotId?: string; actor?: 'agent' | 'human';
    manualSync?: boolean; observeOnly?: boolean; replySamePassProofVersion?: 1;
    sessionId?: string; bindingVersion?: number; answeredMessageIds?: string[];
  };
}
export type ProspectBridgeResult =
  | { candidates: ProspectCandidate[] }
  | { comments: ProspectComment[]; warnings?: string[] }
  | { outcome: 'submitted' | 'failed' | 'unknown'; evidence?: string; error?: string };
