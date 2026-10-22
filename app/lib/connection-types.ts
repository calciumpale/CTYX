export type ConnectionKind='model';
export interface ConnectionSummary {
  kind:ConnectionKind;
  enabled:boolean;
  configured:boolean;
  source:'none'|'environment'|'account';
  baseUrl:string;
  modelName:string;
  hasSecret:boolean;
  version:number;
  updatedAt:string|null;
}
export interface ConnectionsSnapshot {model:ConnectionSummary;storageReady:boolean;}
export interface ConnectionActionResult {
  connection?:ConnectionSummary;
  test?:{ok:true;detail:string;latencyMs:number};
  message:string;
  error?:string;
}
