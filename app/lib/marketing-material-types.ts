export type MaterialKind='presentation'|'image'|'video';
export type MaterialStatus='submitting'|'submission_unknown'|'queued'|'processing'|'saving'|'completed'|'failed'|'expired';
export interface MaterialSlide {title:string;bullets:string[];}
export interface MaterialInput {kind:MaterialKind;prompt:string;target:string;sellingPoints:string;reference:string;size:'1:1'|'2:3'|'3:2';n:number;duration:number;aspectRatio:'16:9'|'9:16'|'1:1';}
export interface MaterialFile {key:string;type:string;name:string;}
export interface MaterialTask {id:string;ownerId:string;memberId:string;requestId:string;payloadHash:string;version:number;status:MaterialStatus;input:MaterialInput;providerTaskId?:string;progress:number;error?:string;files:MaterialFile[];slides:MaterialSlide[];createdAt:string;updatedAt:string;pollAt:number;}
export type PublicMaterialTask=Omit<MaterialTask,'ownerId'|'memberId'|'payloadHash'|'providerTaskId'|'files'>&{files:{name:string;type:string;url:string}[]};
export interface MaterialConnection {kind:'apimart';configured:boolean;enabled:boolean;version:number;imageModel:'gpt-image-1-official'|'gpt-image-1.5-official';hasSecret:boolean;storageReady:boolean;}
