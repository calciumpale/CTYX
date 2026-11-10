import { AGENTS, type Run } from './types.ts';

export type RunStatus = NonNullable<Run['status']>;
export type RunSource = 'all' | 'chat' | 'workflow';
export interface RunFilters { search: string; status: 'all' | RunStatus; source: RunSource; }

export function runGenerationLabel(run: Pick<Run, 'mode' | 'answerSource'>): string {
  return run.answerSource === 'property-records' ? '知识库房源筛选' : run.mode === 'live' ? '模型生成' : '本地生成';
}

export function runStatus(run: Run): RunStatus {
  if (run.status === 'paused' || run.status === 'rejected' || run.status === 'failed') return run.status;
  return run.steps.some(step => step.status === 'error') ? 'failed' : 'completed';
}

export function filterRuns(runs: readonly Run[], { search = '', status = 'all', source = 'all' }: Partial<RunFilters> = {}): Run[] {
  const query = search.trim().toLocaleLowerCase('zh-CN');
  return runs.filter(run => {
    if (status !== 'all' && runStatus(run) !== status) return false;
    if (source === 'workflow' && !run.workflowId) return false;
    if (source === 'chat' && run.workflowId) return false;
    const experts = run.agentIds.map(id => AGENTS.find(agent => agent.id === id)?.name ?? id).join(' ');
    return `${run.query} ${run.answer} ${experts} ${run.id}`.toLocaleLowerCase('zh-CN').includes(query);
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

export function groupRunsByDate(runs: readonly Run[]): { date: string; runs: Run[] }[] {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const parts = dayFormat.formatToParts(new Date(run.createdAt));
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
    const date = `${value('year')}-${value('month')}-${value('day')}`;
    const group = groups.get(date);
    if (group) group.push(run);
    else groups.set(date, [run]);
  }
  return [...groups].map(([date, items]) => ({ date, runs: items }));
}

export function runAnswerForDisplay(answer: string): string {
  return answer.replace(/^[\t ]*演示生成 · 未调用外部模型[\t ]*(?:\r?\n|$)/gm, '');
}
