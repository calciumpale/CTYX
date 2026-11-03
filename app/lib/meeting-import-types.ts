export interface MeetingRecord {
  key: string;
  meetingRecordId: string;
  recordFileId: string;
  meetingId?: string;
  meetingCode?: string;
  subject: string;
  state: string;
  startedAt?: string;
  kind: 'audio' | 'video' | 'unknown';
}

export interface MeetingEvidence {
  field: string;
  value: string;
  quote: string;
  source: 'minutes' | 'transcript';
}

export interface MeetingEntity {
  name: string;
  quote: string;
  source: 'minutes' | 'transcript';
  facts: MeetingEvidence[];
}

export interface MeetingAnalysis {
  status: 'pending' | 'ready' | 'failed' | 'needs_model';
  summary: string;
  companies: MeetingEntity[];
  people: MeetingEntity[];
  nextSteps: string[];
  message?: string;
}

export interface MeetingMedia {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

export interface MeetingImport {
  id: string;
  dealId: string;
  record: MeetingRecord;
  createdAt: string;
  createdBy: string;
  sourceHash: string;
  minutes: string;
  transcript: string;
  complete: boolean;
  warnings: string[];
  analysis: MeetingAnalysis;
  media?: MeetingMedia;
}

export type MeetingImportSummary = Omit<MeetingImport, 'minutes' | 'transcript'>;
export type MeetingJobKind = 'search' | 'import';
export type MeetingJobStatus = 'queued' | 'running' | 'done' | 'failed';
export interface MeetingJobView {
  id: string;
  kind: MeetingJobKind;
  status: MeetingJobStatus;
  createdAt: string;
  error?: string;
  records?: MeetingRecord[];
  importId?: string;
  hasMore?: boolean;
  pageToken?: string;
  search?: MeetingSearchInput;
}

export interface MeetingSyncView {
  device: { id?: string; label?: string; online: boolean; authorized: boolean; lastSeenAt?: string };
  jobs: MeetingJobView[];
  imports: MeetingImportSummary[];
}

export interface MeetingSearchInput { query?: string; meetingCode?: string; pageToken?: string }
export interface MeetingImportInput { record: MeetingRecord; dealId: string; includeAudio: boolean }
export interface MeetingBridgeJob {
  id: string;
  leaseToken: string;
  kind: MeetingJobKind;
  input: MeetingSearchInput | MeetingImportInput;
}
export interface MeetingBridgeImportResult {
  minutes: string;
  transcript: string;
  complete: boolean;
  warnings: string[];
}
