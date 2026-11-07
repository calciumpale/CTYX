export type ProspectChatActor = 'customer' | 'agent' | 'human';
export type ProspectChatMode = 'agent' | 'human';
export type ProspectChatDirection = 'inbound' | 'outbound';
export type ProspectChatGrade = 'high' | 'medium' | 'low';
export type ProspectContactType = 'phone' | 'wechat' | 'email';

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
  handoffReason?: string;
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
  sync?: { conversationId: string; status: ProspectJobStatus; updatedAt: string; error?: string };
}

export interface ProspectChatAgentInput {
  campaign: { name: string; requirements: string; minIntentScore: number };
  conversation: Pick<ProspectChatConversation, 'nickname'> & Partial<Pick<ProspectChatConversation, 'mode'>>;
  messages: ProspectChatMessage[];
  inbound: Pick<ProspectChatMessage, 'id' | 'text'>;
  pending?: Pick<ProspectChatMessage, 'id' | 'text'>[];
}

export interface ProspectChatDecision {
  action: 'reply' | 'handoff' | 'wait';
  reply?: string;
  reason?: string;
  evidenceIds?: string[];
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
