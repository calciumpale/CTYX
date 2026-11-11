import type {TaskMemoryState,TaskMemoryView} from './prospecting-memory-types.ts';
import type {PropertyPageContext,PropertyQuery} from './property-query.ts';
export type ProspectChatActor = 'customer' | 'agent' | 'human';
export type ProspectChatMode = 'agent' | 'human';
export type ProspectChatDirection = 'inbound' | 'outbound';
export type ProspectChatGrade = 'high' | 'medium' | 'low';
export type ProspectContactType = 'phone' | 'wechat' | 'email';

export interface ProspectChatPolicy {
  libraryIds: string[];
  replyDailyLimit: number;
  conversationReplyLimit: number;
  replyHoursEnabled?: boolean;
  workStart: string;
  workEnd: string;
}

export interface ProspectChatMemory {
  needs: Partial<Record<'area' | 'category' | 'budget' | 'location' | 'timing' | 'visit', string>>;
  stage: 'understanding' | 'qualifying' | 'contact' | 'visit' | 'handoff' | 'closed';
  contactCaptured: boolean;
  contactDeclines: number;
  contactAsks: number;
  summary: string;
}

export interface ProspectChatConversation {
  id: string;
  campaignId: string;
  leadId: string;
  nickname: string;
  recipientId: string;
  profileUrl: string;
  mode: ProspectChatMode;
  status: 'active' | 'closed';
  version: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  /** Time of the last reliable platform observation, independent of UI refreshes and failed reads. */
  lastSyncedAt?: string;
  handoffReason?: string;
  memory?: ProspectChatMemory;
  taskMemory?: TaskMemoryView;
  memoryEditable?: boolean;
  closeReason?: string;
  updatedAt: string;
}

export interface ProspectChatMessage {
  id: string;
  conversationId: string;
  direction: ProspectChatDirection;
  text: string;
  contentType?: 'text' | 'image';
  actor: ProspectChatActor;
  status: 'received' | 'queued' | 'waiting' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled';
  /** True only when the attempt is confirmed to have stopped before dispatch. */
  retryable?: boolean;
  retryAt?: string;
  retryExhausted?: boolean;
  postedAt?: string;
  createdAt: string;
  error?: string;
}

export interface ProspectCapturedLead {
  id: string;
  conversationId: string;
  nickname: string;
  contactType: ProspectContactType;
  contactValue: string;
  grade: ProspectChatGrade;
  score: number;
  reason: string;
  assignedMemberId: string | null;
  assignedName: string | null;
  status: 'assigned' | 'unassigned';
  updatedAt: string;
}

export interface ProspectChatSnapshot {
  enabled: boolean;
  online: boolean;
  conversations: ProspectChatConversation[];
  messages: ProspectChatMessage[];
  pool: ProspectCapturedLead[];
  policy?: ProspectChatPolicy;
  libraries?: { id: string; name: string }[];
  memoryTasks?: { id: string; name: string }[];
  sync?: { conversationId: string; status: ProspectJobStatus; updatedAt: string; error?: string };
}

export interface ProspectKnowledgeLookup {department:import('./knowledge-department-scope.ts').KnowledgeDepartmentId|null;libraryIds:string[];sourceIds:string[];status:'ok'|'failed';}
export interface ProspectChatAgentInput {
  /** Server-populated from the persisted conversation, never from request payload. */
  memberId?:string;
  campaign: { name: string; requirements: string; minIntentScore: number };
  conversation: Pick<ProspectChatConversation, 'nickname'> & Partial<Pick<ProspectChatConversation, 'mode' | 'memory' | 'taskMemory'>>;
  policy?: ProspectChatPolicy;
  messages: ProspectChatMessage[];
  inbound: Pick<ProspectChatMessage, 'id' | 'text' | 'contentType'>;
  now?: string;
  pending?: Pick<ProspectChatMessage, 'id' | 'text' | 'contentType'>[];
  /** Only the store may supply context from a confirmed outbound reply. */
  propertyPage?:PropertyPageContext|null;
}

export interface ProspectChatDecision {
  knowledgeLookup?:ProspectKnowledgeLookup;
  action: 'reply' | 'handoff' | 'wait';
  reply?: string;
  reason?: string;
  evidenceIds?: string[];
  memory?: ProspectChatMemory;
  taskMemoryState?: TaskMemoryState;
  answeredMessageIds?: string[];
  propertyQuery?:PropertyQuery;
  propertyHasNext?:boolean;
  route?: 'direct' | 'retrieve' | 'fallback' | 'handoff';
  close?: boolean;
  lead?: {
    contactType: ProspectContactType;
    contactValue: string;
    score: number;
    grade: ProspectChatGrade;
    reason: string;
  };
}

export interface ProspectChatReadResult {
  senderAccountId: string;
  recipientId: string;
  observedAt: string;
  snapshotId: string;
  reliable: boolean;
  covered?: boolean;
  messages: { id: string; direction: ProspectChatDirection; text: string; contentType?: 'text' | 'image'; postedAt?: string }[];
}
import type { ProspectJobStatus } from './prospecting-types.ts';
