import type { FollowupRecording } from './types.ts';

export const RECORDING_INBOX_DEAL_ID = 'recording-inbox';

export type RecordingInboxEntry = { recording: FollowupRecording; createdAt: string };
export type RecordingInboxPage = { recordings: RecordingInboxEntry[]; nextCursor: string | null };
