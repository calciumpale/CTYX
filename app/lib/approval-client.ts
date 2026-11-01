import type { ApprovalActor, ApprovalKind, ApprovalRequest, ApprovalStatus, ApprovalSummary, ApprovalTemplate, SubmitApprovalPayload } from './approval-types';

export type ApprovalScope = 'inbox' | 'mine' | 'all' | 'templates';
export interface ApprovalListResult { identity: ApprovalActor; requests: ApprovalSummary[]; templates: ApprovalTemplate[]; pendingCount: number; nextCursor?: string; }
export interface ApprovalDetailResult { identity: ApprovalActor; request: ApprovalRequest; }
export interface ApprovalListQuery { scope?: ApprovalScope; projectId?: string; status?: ApprovalStatus | ''; q?: string; cursor?: string; limit?: number; }
export class ApprovalClientError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = 'ApprovalClientError'; }
  get conflict() { return this.status === 409; }
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init }); }
  catch (failure) { if (failure instanceof Error && failure.name === 'AbortError') throw failure; throw new ApprovalClientError('网络连接中断，编辑内容已保留。请检查网络后重试。', 0); }
  let body: unknown;
  try { body = await response.json(); } catch { throw new ApprovalClientError('审批服务暂时未返回有效结果，请稍后重试。', response.status); }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : '审批操作未完成，请重试。';
    throw new ApprovalClientError(message, response.status);
  }
  return body as T;
}
async function mutate<T>(action: string, payload: unknown): Promise<T> {
  const result = await request<T>('/api/approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
  window.dispatchEvent(new CustomEvent('ctai-approvals-updated'));
  return result;
}
export function listApprovals(query: ApprovalListQuery, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if ((query.scope !== 'templates' || key === 'scope') && value !== undefined && value !== '') params.set(key, String(value));
  return request<ApprovalListResult>(`/api/approvals?${params}`, { signal }).then(value=>({...value,requests:value.requests??[],pendingCount:value.pendingCount??0}));
}
export function getApproval(id: string, signal?: AbortSignal) { return request<ApprovalDetailResult>(`/api/approvals?id=${encodeURIComponent(id)}`, { signal }); }
export function submitApproval(payload: SubmitApprovalPayload) { return mutate<{ request: ApprovalRequest; message: string }>('submit', payload); }
export function decideApproval(payload: { id: string; version: number; decision: 'approve' | 'reject' | 'return'; note?: string }) { return mutate<{ request: ApprovalRequest; message: string }>('decide', payload); }
export function withdrawApproval(payload: { id: string; version: number }) { return mutate<{ request: ApprovalRequest; message: string }>('withdraw', payload); }
export function saveApprovalTemplate(payload: { id: string; name: string; kind: ApprovalKind; steps: ApprovalTemplate['steps']; version: number }) { return mutate<{ template: ApprovalTemplate; message: string }>('template_save', payload); }
export function deleteApprovalTemplate(payload: { id: string; version: number }) { return mutate<{ message: string }>('template_delete', payload); }
