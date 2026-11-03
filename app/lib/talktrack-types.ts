export interface CallTranscript {id:string;dealId:string;employeeId:string;employeeName:string;text:string;source:'pasted'|'file'|'meeting';createdAt:string;}
export interface TalkTrackDraft {topic:string;scenario:string;template:string;keywords:string[];objectionLogic:string[];steps:string[];boundaries:string[];leadTypes:string[];evidence:{transcriptId:string;quote:string}[];confidence:number;}
export interface TalkTrack extends TalkTrackDraft {id:string;title:string;employeeId:string;employeeName:string;dealId:string;status:'candidate'|'published'|'rejected'|'archived';version:number;createdAt:string;updatedAt:string;publishedAt?:string;reviewer?:string;reviewNote?:string;weight:number;}
export interface FeedbackJob {id:string;dealId:string;status:'waiting_transcript'|'waiting_config'|'queued'|'running'|'review'|'done'|'failed'|'duplicate'|'screened_out';message:string;sourceHash:string;candidateIds:string[];createdAt:string;updatedAt:string;leaseToken?:string;leaseUntil?:string;}
export interface TalkTrackUsage {trackId:string;dealId?:string;runId:string;usedAt:string;}
export interface TalkTrackPolicy {enabled:boolean;minClosedProjects:number;winRateBelow:number;idleDays:number;action:'downweight'|'archive';lastRunAt?:string;}
export const DEFAULT_TALKTRACK_POLICY:TalkTrackPolicy={enabled:false,minClosedProjects:10,winRateBelow:0.2,idleDays:30,action:'downweight'};
export interface StoredVector {id:string;title:string;vector:number[];model:string;}
