export type ProjectUrgency = 'none' | 'upcoming' | 'urgent' | 'overdue';
export type DeadlineProject = { deadline?: string; cardColor?: string; outcome?: 'open' | 'won' | 'lost' };
export type ProjectCardTone = 'default' | 'custom' | 'red' | 'orange';
const HOUR = 60 * 60 * 1000;
export interface DeadlineRules { urgentDays: number; warningDays: number }
export const DEFAULT_DEADLINE_RULES: DeadlineRules = { urgentDays: 2, warningDays: 5 };

/** Exact elapsed-hour thresholds; closed projects no longer need action reminders. */
export function projectUrgency(project: DeadlineProject, now: number = Date.now(), rules: DeadlineRules = DEFAULT_DEADLINE_RULES): ProjectUrgency {
  if (project.outcome === 'won' || project.outcome === 'lost') return 'none';
  const deadline = Date.parse(project.deadline || '');
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return 'none';
  const remaining = deadline - now;
  if (remaining <= 0) return 'overdue';
  if (remaining < rules.urgentDays * 24 * HOUR) return 'urgent';
  if (remaining < rules.warningDays * 24 * HOUR) return 'upcoming';
  return 'none';
}

export function normalizedCardColor(value?: string): string | undefined {
  return /^#[\da-f]{6}$/i.test(value || '') ? value!.toLowerCase() : undefined;
}

/** Custom color wins visually; projectUrgency still supplies an independent text badge. */
export function projectCardTone(project: DeadlineProject, now: number = Date.now(), rules: DeadlineRules = DEFAULT_DEADLINE_RULES): ProjectCardTone {
  if (normalizedCardColor(project.cardColor)) return 'custom';
  const urgency = projectUrgency(project, now, rules);
  return urgency === 'urgent' || urgency === 'overdue' ? 'red' : urgency === 'upcoming' ? 'orange' : 'default';
}

export function urgencyLabel(urgency: ProjectUrgency, rules: DeadlineRules = DEFAULT_DEADLINE_RULES): string {
  return ({ none: '', upcoming: `${rules.warningDays}天内截止`, urgent: `${rules.urgentDays}天内截止`, overdue: '已逾期' })[urgency];
}

/** datetime-local is explicitly presented as Beijing time, regardless of browser timezone. */
export function deadlineInputValue(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const read = (type: string) => parts.find(part => part.type === type)?.value;
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}`;
}

export function deadlineFromInput(value: string): string {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请填写有效的截止日期和时间');
  const parsed = Date.parse(`${value}:00+08:00`);
  if (!Number.isFinite(parsed) || deadlineInputValue(new Date(parsed).toISOString()) !== value) throw new Error('请填写有效的截止日期和时间');
  return new Date(parsed).toISOString();
}
