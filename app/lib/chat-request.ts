import type { Run } from './types.ts';

/** Only complete assistant turns can supply context or satisfy a send request. */
export function isCompletedChatRun(run: Run): boolean {
  return !run.workflowId && (!run.status || run.status === 'completed')
    && typeof run.answer === 'string' && Boolean(run.answer.trim())
    && Array.isArray(run.steps) && !run.steps.some(step => step?.status === 'error');
}

export function isMatchingChatRun(run: Run | undefined, request: { query: string; dealId?: string }): run is Run {
  return Boolean(run && isCompletedChatRun(run) && run.query === request.query.trim()
    && (request.dealId === undefined || run.dealId === request.dealId));
}
