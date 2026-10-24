export type SalesEventKind='create'|'update'|'stage'|'outcome'|'followup'|'transcript';
export interface SalesEvent {
  id:string;projectId:string;projectName:string;ownerId:string;ownerName:string;kind:SalesEventKind;occurredAt:string;sourceVersion:number;sourceId?:string;
  changes:Record<string,{before:string|number|null;after:string|number|null}>;text:string;
}
export type SalesEventCounts=Partial<Record<SalesEventKind,number>>&{won?:number;lost?:number};
export interface SalesEvidence {id:string;projectId:string;projectName:string;kind:SalesEventKind|'snapshot';at:string;text:string;}
export interface SalesProjectSummary {id:string;name:string;company:string;owner:string;stage:string;amount:number;nextAction:string;risks:string[];urgency:'none'|'upcoming'|'urgent'|'overdue';grade?:'A'|'B'|'C';}
export interface SalesSnapshot {
  date:string;timeZone:'Asia/Shanghai';periodStart:string;periodEnd:string;cutoffAt:string;snapshotAt:string;coverageStart:string;sourceRevision:number;
  eventCount:number;eventsShown:number;excludedSampleProjects:number;
  metrics:{newProjects:number;updatedProjects:number;followups:number;transcripts:number;stageChanges:number;won:number;lost:number;openProjects:number;openAmount:number;overdue:number;urgent:number;aLeads:number;pendingApprovals:number;};
  stages:{stage:string;count:number;amount:number}[];
  owners:{id:string;name:string;openProjects:number;openAmount:number;events:number}[];
  priorities:SalesProjectSummary[];evidence:SalesEvidence[];limitations:string[];
}
export interface SalesNarrative {summary:string;observations:{text:string;evidenceIds:string[]}[];}
export type SalesReportStatus='running'|'completed'|'waiting_config'|'failed';
export interface SalesReport {date:string;status:SalesReportStatus;mode:'facts'|'model';generatedAt:string;updatedAt:string;version:number;sourceHash:string;snapshot:SalesSnapshot;narrative?:SalesNarrative;modelName?:string;message:string;retryable?:boolean;}
export interface SalesReportSummary {date:string;status:SalesReportStatus;mode:'facts'|'model';updatedAt:string;newProjects:number;followups:number;}
export interface SalesReportList {report:SalesReport|null;reports:SalesReportSummary[];coverageStart:string|null;today:string;}
export interface SalesReportReadback {date:string;verified:number;statuses:Record<SalesReportStatus,number>;}
export interface SalesReportDispatch {date:string;processed:number;generated:number;existing:number;waitingConfig:number;failed:number;hasMore:boolean;readback:SalesReportReadback;nextCursor?:string;}
