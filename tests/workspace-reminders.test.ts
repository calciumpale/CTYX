import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveProjectReminders, type ReminderProject } from '../app/lib/workspace-reminders.ts';

const now = Date.parse('2026-11-07T02:00:00Z');
const project = (id: string, hours: number, patch: Partial<ReminderProject> = {}): ReminderProject => ({
  id, name: `企业 ${id}`, projectName: `项目 ${id}`, nextAction: '确认下一步安排',
  deadline: new Date(now + hours * 3_600_000).toISOString(), ...patch,
});

test('reminders use elapsed-time deadline boundaries and update overdue status at the deadline', () => {
  const { items, counts } = deriveProjectReminders([
    project('due', 0), project('urgent', 47.999), project('upcoming', 48),
    project('last-warning', 119.999), project('outside', 120),
  ], now);
  assert.deepEqual(items.map(item => [item.dealId, item.urgency]), [
    ['due', 'overdue'], ['urgent', 'urgent'], ['upcoming', 'upcoming'], ['last-warning', 'upcoming'],
  ]);
  assert.deepEqual(counts, { total: 4, overdue: 1, urgent: 1, upcoming: 2 });
  assert.equal(deriveProjectReminders([project('due', 1)], now + 3_600_000).items[0].urgency, 'overdue');
});

test('closed, archived, undated, invalid and out-of-window projects do not inflate reminder counts', () => {
  const result = deriveProjectReminders([
    project('won', -1, { outcome: 'won' }), project('lost', -2, { outcome: 'lost' }),
    project('archived', -3, { outcome: 'open', archive: { at: new Date(now).toISOString(), reason: '移入历史', migrationKey: 'archive-test' } }),
    project('undated', 1, { deadline: undefined }), project('invalid', 1, { deadline: 'invalid' }),
    project('later', 140), project('open', -4, { outcome: 'open' }),
  ], now);
  assert.deepEqual(result.items.map(item => item.dealId), ['open']);
  assert.deepEqual(result.counts, { total: 1, overdue: 1, urgent: 0, upcoming: 0 });
});

test('saved deadline rules drive reminder visibility and urgency', () => {
  const result = deriveProjectReminders([
    project('urgent', 95.999), project('warning', 96), project('outside', 240),
  ], now, { urgentDays: 4, warningDays: 10 });
  assert.deepEqual(result.items.map(item => [item.dealId, item.urgency]), [['urgent', 'urgent'], ['warning', 'upcoming']]);
  assert.deepEqual(result.counts, { total: 2, overdue: 0, urgent: 1, upcoming: 1 });
});

test('only the caller-visible input contributes reminders, with stable deadline order and no mutation', () => {
  const authorized = [project('later', 72), project('urgent', 8), project('overdue', -6)];
  const snapshots = authorized.map(item => ({ ...item }));
  const result = deriveProjectReminders(authorized, now);
  assert.deepEqual(result.items.map(item => item.dealId), ['overdue', 'urgent', 'later']);
  assert.deepEqual(authorized, snapshots);
  const restricted = deriveProjectReminders(authorized.filter(item => item.id === 'urgent'), now);
  assert.deepEqual(restricted.items.map(item => item.dealId), ['urgent']);
  assert.deepEqual(restricted.counts, { total: 1, overdue: 0, urgent: 1, upcoming: 0 });
});

test('all visible reminders are counted and actionable without creating schedule records', () => {
  const projects = Array.from({ length: 12 }, (_, index) => project(`p${index}`, index + 1));
  const { items, counts } = deriveProjectReminders(projects, now);
  assert.equal(items.length, 12);
  assert.deepEqual(counts, { total: 12, overdue: 0, urgent: 12, upcoming: 0 });
  assert.deepEqual(items[0], {
    dealId: 'p0', title: '项目 p0', company: '企业 p0', deadline: '2026-11-07T03:00:00.000Z',
    nextAction: '确认下一步安排', urgency: 'urgent',
  });
  assert.equal(deriveProjectReminders([project('untitled', 1, { projectName: '' })], now).items[0].title, '企业 untitled');
  assert.deepEqual(deriveProjectReminders([], now).counts, { total: 0, overdue: 0, urgent: 0, upcoming: 0 });
});
