export interface RecordingQuote {
  id: string;
  dealId: string;
  projectName: string;
  recordingId: string;
  recordingName: string;
  speaker: string;
  start: number;
  end: number;
  text: string;
  createdAt: string;
  canDelete: boolean;
}
