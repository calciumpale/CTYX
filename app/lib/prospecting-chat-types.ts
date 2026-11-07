export type ProspectChatActor = 'customer' | 'agent' | 'human';
export type ProspectChatMode = 'agent' | 'human';
export type ProspectChatDirection = 'inbound' | 'outbound';
export type ProspectChatGrade = 'high' | 'medium' | 'low';
export type ProspectContactType = 'phone' | 'wechat' | 'email';

export interface ProspectChatPolicy {
  libraryIds: string[];
  replyDailyLimit: number;
  conversationReplyLimit: number;
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
  closeReason?: string;
  updatedAt: string;
}

export interface ProspectChatMessage {
  id: string;
  conversationId: string;
  direction: ProspectChatDirection;
  text: string;
  actor: ProspectChatActor;
  status: 'received' | 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled';
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
  sync?: { conversationId: string; status: ProspectJobStatus; updatedAt: string; error?: string };
}

export interface ProspectChatAgentInput {
  campaign: { name: string; requirements: string; minIntentScore: number };
  conversation: Pick<ProspectChatConversation, 'nickname'> & Partial<Pick<ProspectChatConversation, 'mode' | 'memory'>>;
  policy?: ProspectChatPolicy;
  messages: ProspectChatMessage[];
  inbound: Pick<ProspectChatMessage, 'id' | 'text'>;
  pending?: Pick<ProspectChatMessage, 'id' | 'text'>[];
}

export interface ProspectChatDecision {
  action: 'reply' | 'handoff' | 'wait';
  reply?: string;
  reason?: string;
  evidenceIds?: string[];
  memory?: ProspectChatMemory;
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
  messages: { id: string; direction: ProspectChatDirection; text: string; postedAt?: string }[];
}
import type { ProspectJobStatus } from './prospecting-types.ts';
