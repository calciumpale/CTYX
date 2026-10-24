export const CONTRACT_TYPES=['销售合同','采购合同','服务合同','租赁合同','其他合同'] as const;
export type ContractKind=typeof CONTRACT_TYPES[number];
export type ContractParty='甲方'|'乙方'|'待确认';
export type ContractRiskLevel='high'|'medium'|'low';
export type ContractFindingStatus='open'|'revised'|'legal';
export interface ContractFinding {id:string;clauseId:string;quote:string;start:number;end:number;level:ContractRiskLevel;title:string;reason:string;suggestion:string;replacement:string;status:ContractFindingStatus;}
export interface ContractMissingItem {id:string;title:string;reason:string;suggestion:string;}
export interface ContractAnalysis {summary:string;findings:ContractFinding[];missingItems:ContractMissingItem[];coverage:{characters:number;clauses:number;chunks:number};warnings:string[];}
export interface ContractReviewInput {text:string;title:string;contractType:ContractKind;ourParty:ContractParty;focus:string;projectContext?:string;}
export interface ContractDocument extends Omit<ContractReviewInput,'projectContext'> {id:string;dealId:string;version:number;createdAt:string;updatedAt:string;createdBy:string;fileName?:string;sourceFormat:'paste'|'txt'|'docx'|'pdf';importWarnings?:string[];analysis?:ContractAnalysis;reviewedAt?:string;modelName?:string;}
