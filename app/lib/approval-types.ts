import type { ContractDocument } from './contract-types.ts';

export type ApprovalKind = 'business' | 'contract';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'returned' | 'withdrawn' | 'superseded';
export type ApprovalStepStatus = 'waiting' | 'pending' | 'approved' | 'rejected' | 'returned';
export type ApprovalAction = 'approve' | 'reject' | 'return' | 'withdraw';
export interface ApprovalActor {salesId?:string; id: string; email: string; name: string; workspaceId?:string; memberRole?:'sales'|'manager'|'admin'; }
export interface ApprovalRouteStep {
  id: string;
  label: string;
  role: 'manager' | 'finance' | 'legal' | 'executive' | 'other';
  approverName: string;
  approverEmail: string;
}
export interface ApprovalStep extends ApprovalRouteStep {
  status: ApprovalStepStatus;
  note?: string;
  decidedAt?: string;
  decidedBy?: ApprovalActor;
}
export interface ApprovalTemplate { id: string; ownerId: string; name: string; kind: ApprovalKind; steps: ApprovalRouteStep[]; version: number; updatedAt: string; }
export interface BusinessCondition { id: string; category: string; subject: string; baseline: string; proposed: string; reason: string; }
export interface ApprovalProjectSnapshot { id: string; name: string; company: string; owner: string; amount: number; stage: string; }
export interface ApprovalSnapshot { project: ApprovalProjectSnapshot; conditions?: BusinessCondition[]; contract?: ContractDocument; }
export interface ApprovalHistoryEvent { id: string; action: 'submit' | 'supersede' | ApprovalAction; actor: ApprovalActor; at: string; stepId?: string; stepIndex?: number; note?: string; }
export interface ApprovalRequest {
  id: string;
  ownerId: string;
  projectId: string;
  kind: ApprovalKind;
  title: string;
  reason: string;
  deadline?: string;
  status: ApprovalStatus;
  steps: ApprovalStep[];
  currentStep: number;
  snapshot: ApprovalSnapshot;
  sourceHash?: string;
  /** Full semantic submission and saved-source fingerprint, independent of request ID and time. */
  contentHash: string;
  /** Original client payload excluding its ID, for safe retries even after a source changes. */
  inputHash: string;
  activeKey: string;
  applicant: ApprovalActor;
  history: ApprovalHistoryEvent[];
  version: number;
  createdAt: string;
  updatedAt: string;
  previousRequestId?: string;
}
export interface ApprovalSummary {
  id: string;
  ownerId: string;
  projectId: string;
  kind: ApprovalKind;
  title: string;
  reason: string;
  deadline?: string;
  status: ApprovalStatus;
  currentStep: number;
  stepCount: number;
  applicant: ApprovalActor;
  version: number;
  createdAt: string;
  updatedAt: string;
  previousRequestId?: string;
  projectName: string;
  companyName: string;
  currentApprover: string;
  currentApproverEmail?: string;
  riskCount: number;
  isApplicant: boolean;
  canDecide: boolean;
  canWithdraw: boolean;
  stale?: boolean;
}
export interface SubmitApprovalPayload {
  id: string;
  projectId: string;
  kind: ApprovalKind;
  title: string;
  reason: string;
  deadline?: string;
  steps: ApprovalRouteStep[];
  conditions?: BusinessCondition[];
  contractId?: string;
  contractVersion?: number;
  previousRequestId?: string;
}
