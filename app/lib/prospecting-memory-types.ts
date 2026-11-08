import type {ProspectChatMessage,ProspectChatMemory} from './prospecting-chat-types.ts';
export type TaskMemoryMessage=ProspectChatMessage & {rowOrder?:number;actorVerified?:boolean;legacyBudgetCovered?:boolean;answeredMessageIds?:string[]};
export type TaskMemoryKey=keyof ProspectChatMemory['needs']|'constraint'|'preference'|'next_step';
export type TaskMemoryStatus='confirmed'|'tentative'|'retracted'|'superseded'|'stale'|'ignored';
export interface TaskMemoryFact {
 id:string; key:TaskMemoryKey; value:string; status:TaskMemoryStatus; sourceMessageId:string; sourceText:string;
 actor:'customer'|'agent'|'human'|'system'; sourceAt:string; updatedAt:string; supersedes?:string; version?:number;
 actorId?:string; expiresAt?:string;sourceMessageIds?:string[];
}
export interface TaskMemoryEvent {
 id:string; type:'customer_question'|'submitted_verified'|'pending'|'uncertain'|'contact_declined'|'contact_captured'|'human_edit'|'sales_confirmed'|'system_verified';
 sourceMessageId:string; sourceText:string; actor:TaskMemoryFact['actor']; sourceAt:string; updatedAt:string;
 key?:string; factId?:string; actorId?:string;legacyBudgetCovered?:boolean;status?:'open'|'resolved';resolvedBy?:string;answeredMessageIds?:string[];
}
export interface TaskMemoryState {
 schemaVersion:2; facts:TaskMemoryFact[]; events:TaskMemoryEvent[]; ignoredSourceIds:string[]; sourceWatermark:number; summary:string; updatedAt:string;
 contact:{captured:boolean;declined:boolean;submittedInvites:number;legacyInvites:number;pendingInvites:number;uncertainInvites:number};
 /** Migration suppressions are independent of reconstructible submitted events. */
 legacyDeclines?:number;
 processedSourceIds?:string[];
 pendingSourceIds?:string[];
}
export interface TaskMemoryView {
 sessionId:string; campaignId:string; activeCampaignId:string|null; activeCampaignName?:string; isActive:boolean;
 sessionVersion:number; bindingVersion:number; ready:boolean; state:TaskMemoryState;
 threadId?:string; sourceWatermark?:number; threadVersion?:number; sourceVersion?:number; active?:boolean;
}
export interface TaskMemoryEdit {factId:string;operation:'correct'|'retract'|'ignore';value?:string;actorId:string;now:string}
export interface TaskMemoryOptions {now:string;timeZone?:string}
export interface TaskMemoryContext {
 facts:TaskMemoryFact[];summary:string;recent:TaskMemoryMessage[];recalled:TaskMemoryMessage[];overflow:boolean;
}
