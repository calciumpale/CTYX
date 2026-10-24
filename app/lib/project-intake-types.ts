import type { CustomerProfile } from './types.ts';

/** Only fields the existing project form can save. Missing facts are omitted. */
export interface IntakeFields {
  name?: string;
  projectName?: string;
  contact?: string;
  position?: string;
  industry?: string;
  amount?: number;
  summary?: string;
  needs?: string[];
  source?: string;
  nextAction?: string;
  customerProfile?: Partial<CustomerProfile>;
  website?: string;
  region?: string;
  stage?: string;
}
export type IntakeEvidenceField = Exclude<keyof IntakeFields, 'customerProfile'> | `customerProfile.${keyof CustomerProfile}`;
export interface IntakeEvidence { field: IntakeEvidenceField; quote: string }
export interface IntakeExtraction {
  status: 'ready' | 'needs_info';
  fields: IntakeFields;
  evidence: IntakeEvidence[];
  companyCandidates: string[];
  question?: string;
}
export interface IntakeResponse {
  status: 'needs_info' | 'duplicate';
  question?: string;
  draft?: IntakeExtraction;
  existing?: { id: string; name: string; projectName?: string }[];
}
export type IntakeInputMode = 'text' | 'speech';
