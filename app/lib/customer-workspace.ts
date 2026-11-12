import type { AgentId, Deal, Run } from './types.ts';
import { isCompletedChatRun } from './chat-request.ts';

export interface CustomerCompany { key: string; name: string; projects: Deal[]; }
export interface CustomerChatRequest { query: string; dealId: string; conversationRunIds: string[]; agentId?: AgentId; }
export type CustomerDirectoryScope = 'active' | 'archived';
const compare = (a: string, b: string) => a.localeCompare(b, 'zh-CN') || (a < b ? -1 : a > b ? 1 : 0);
export const normalizedCompanyName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
const displayName = (deal: Deal) => (deal.name.trim() || deal.companyProfile?.companyName.trim() || '未命名企业').normalize('NFKC').replace(/\s+/g, ' ');

/** The caller supplies server-scoped deals. Research aliases never join two differently named clients. */
export function companyDirectory(deals: readonly Deal[], scope: CustomerDirectoryScope = 'active'): CustomerCompany[] {
  const groups = new Map<string, Deal[]>();
  for (const deal of deals) {
    if (Boolean(deal.archive) !== (scope === 'archived')) continue;
    const name = normalizedCompanyName(deal.name.trim() || deal.companyProfile?.companyName || '');
    const key = name ? `company:${name}` : `unnamed:${deal.id}`;
    groups.set(key, [...(groups.get(key) || []), deal]);
  }
  return [...groups].map(([key, projects]) => {
    const sorted = [...projects].sort((a, b) => compare(a.projectName || a.name, b.projectName || b.name) || compare(a.id, b.id));
    const name = projects.map(displayName).sort(compare)[0];
    return { key, name, projects: sorted };
  }).sort((a, b) => compare(a.name, b.name) || compare(a.key, b.key));
}
export function selectCompanyProject(company: CustomerCompany, preferredId?: string | null): string | null {
  return company.projects.find(project => project.id === preferredId)?.id || company.projects[0]?.id || null;
}
export function selectInitialCustomerProject(companies: readonly CustomerCompany[], explicitId?: string | null): string | null {
  if (explicitId) return companies.some(company => company.projects.some(project => project.id === explicitId)) ? explicitId : null;
  return companies[0]?.projects[0]?.id || null;
}
/** A company may have multiple projects; each project keeps its own conversation and context. */
export function customerChatHistory(runs: readonly Run[], dealId?: string | null): Run[] {
  if (!dealId) return [];
  return runs.filter(run => run.dealId === dealId && !run.workflowId).sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || compare(a.id, b.id));
}
export function buildCustomerChatRequest({ query, dealId, runs, agentId }: { query: string; dealId: string; runs: readonly Run[]; agentId?: AgentId }): CustomerChatRequest {
  const history = customerChatHistory(runs, dealId).filter(isCompletedChatRun);
  return { query, dealId, conversationRunIds: history.slice(-6).map(run => run.id), ...(agentId ? { agentId } : {}) };
}
