/** Every date-time crosses the API as an explicit ISO instant; unscheduled items use null. */
export type ScheduleKind = 'task' | 'event' | 'visit';
export type ScheduleStatus = 'pending' | 'completed' | 'cancelled';
export interface ScheduleDraft {
  kind: ScheduleKind;
  title: string;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  dealId: string | null;
  location: string;
  notes: string;
}
export interface ScheduleItem extends ScheduleDraft {
  id: string;
  ownerAccountId: string;
  ownerName: string;
  status: ScheduleStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}
export interface ScheduleList {
  items: ScheduleItem[];
  unscheduled: ScheduleItem[];
  scope: 'mine' | 'team';
  truncated: boolean;
  scheduledTruncated: boolean;
  unscheduledCounts: { task: number; visit: number };
  pendingVisitCount: number;
}
export interface ScheduleUnscheduledPage {
  items: ScheduleItem[];
  nextCursor?: string;
  pendingCount: number;
  totalCount: number;
}
export interface ScheduleSuggestion {
  drafts: ScheduleDraft[];
  message: string;
  warnings: string[];
}
export type ScheduleAction =
  | { action: 'create'; requestId: string; draft: ScheduleDraft }
  | { action: 'update'; id: string; version: number; draft: ScheduleDraft }
  | { action: 'status'; id: string; version: number; status: ScheduleStatus }
  | { action: 'delete' | 'restore'; id: string; version: number }
  | { action: 'suggest'; query: string; anchorDate: string };
