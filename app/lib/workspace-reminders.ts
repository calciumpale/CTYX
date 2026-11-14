import { DEFAULT_DEADLINE_RULES, projectUrgency, type DeadlineRules, type ProjectUrgency } from './project-deadline.ts';
import type { Deal } from './types.ts';

export type ReminderProject = Pick<Deal, 'id' | 'name' | 'projectName' | 'deadline' | 'outcome' | 'nextAction' | 'archive'>;
export type ProjectReminder = {
  dealId: string;
  title: string;
  company: string;
  deadline: string;
  nextAction: string;
  urgency: Exclude<ProjectUrgency, 'none'>;
};
export type ProjectReminderCounts = { total: number; overdue: number; urgent: number; upcoming: number };

/** Input is the current permission-filtered workspace, never a separate project source.
 * These derived reminders are read-only and are not persisted as schedule items. */
export function deriveProjectReminders(projects: readonly ReminderProject[], now: number = Date.now(), rules: DeadlineRules = DEFAULT_DEADLINE_RULES): { items: ProjectReminder[]; counts: ProjectReminderCounts } {
  const items: ProjectReminder[] = [];
  const counts: ProjectReminderCounts = { total: 0, overdue: 0, urgent: 0, upcoming: 0 };
  for (const project of projects) {
    if (project.archive) continue;
    const urgency = projectUrgency(project, now, rules);
    if (urgency === 'none') continue;
    items.push({ dealId: project.id, title: project.projectName || project.name, company: project.name, deadline: project.deadline!, nextAction: project.nextAction, urgency });
    counts.total += 1;
    counts[urgency] += 1;
  }
  items.sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline) || a.title.localeCompare(b.title, 'zh-CN') || a.dealId.localeCompare(b.dealId));
  return { items, counts };
}
