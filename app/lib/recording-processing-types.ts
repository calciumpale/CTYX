import type { CustomerProfile } from './types.ts';

export type RecordingProcessingDraft = {
  id: string;
  summary: string;
  decisions: string[];
  followup: string;
  projectName: string;
  matchedDealId: string | null;
  matchReason: string;
  profile: Partial<CustomerProfile>;
  evidence: string[];
  targetVersion: number | null;
};

export type RecordingProcessingStatus = {
  draft: RecordingProcessingDraft | null;
  applied: boolean;
  appliedDealId: string | null;
};

export type RecordingProcessingSource = { dealId: string; recordingId: string; jobId: string; targetDealId?: string };

export type RecordingProcessingApply = {
  dealId: string;
  version: number;
  sourceDealId: string;
  recordingId: string;
  jobId: string;
  draftId: string;
  profile: Partial<CustomerProfile>;
  followup: string;
};
