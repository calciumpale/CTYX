export const SPEECH_DIALECTS = ['auto','mandarin','cantonese','wu','min','hakka','gan','xiang','jin'] as const;
export type SpeechDialect = typeof SPEECH_DIALECTS[number];
export interface SpeechHotword { id:string; term:string; aliases:string[]; enabled:boolean; }
export interface SpeechCapabilities { configured:boolean; available:boolean; model:string; dialects:string[]; diarization:boolean; hotwords:boolean; message?:string; }
export interface SpeechSettings { version:number; hotwords:SpeechHotword[]; dialect:SpeechDialect; diarization:boolean; speakerCount:number|null; capabilities:SpeechCapabilities; }
export interface SpeechSegment { start:number; end:number; speaker:string; text:string; rawText:string; }
export interface SpeechResult { text:string; rawText:string; segments:SpeechSegment[]; speakers:{id:string;label:string}[]; corrections:{from:string;to:string;count:number}[]; model:string; durationSeconds:number; dialectHint:SpeechDialect; diarization:boolean; hotwordVersion:number; }
export interface SpeechTranscriptionJob { id:string; recordingId:string; dealId:string; status:'queued'|'running'|'completed'|'failed'; progress:number; message:string; createdAt:string; updatedAt:string; result?:SpeechResult; linked?:boolean; }
