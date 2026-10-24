import assert from 'node:assert/strict';
import test from 'node:test';
import { deadlineFromInput, deadlineInputValue, normalizedCardColor, projectCardTone, projectUrgency, urgencyLabel } from '../app/lib/project-deadline.ts';

const now = Date.parse('2026-10-24T02:00:00Z');
const hoursFromNow = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

test('uses exact 48-hour and 120-hour urgency boundaries, including overdue', () => {
  for (const hours of [-24, 0]) assert.equal(projectUrgency({ deadline: hoursFromNow(hours) }, now), 'overdue');
  assert.equal(projectUrgency({ deadline: hoursFromNow(47.999) }, now), 'urgent');
  assert.equal(projectUrgency({ deadline: hoursFromNow(48) }, now), 'upcoming');
  assert.equal(projectUrgency({ deadline: hoursFromNow(119.999) }, now), 'upcoming');
  assert.equal(projectUrgency({ deadline: hoursFromNow(120) }, now), 'none');
});

test('ignores unavailable deadlines and suppresses reminders for won or lost projects', () => {
  assert.equal(projectUrgency({}, now), 'none');
  assert.equal(projectUrgency({ deadline: 'invalid' }, now), 'none');
  for (const outcome of ['won', 'lost'] as const) assert.equal(projectUrgency({ outcome, deadline: hoursFromNow(-1) }, now), 'none');
});

test('custom colors override automatic card tints without removing independent urgency text', () => {
  const project = { cardColor: '#44AA77', deadline: hoursFromNow(12) };
  assert.equal(projectCardTone(project, now), 'custom');
  assert.equal(projectUrgency(project, now), 'urgent');
  assert.equal(urgencyLabel(projectUrgency(project, now)), '2天内截止');
  assert.equal(normalizedCardColor(project.cardColor), '#44aa77');
  assert.equal(projectCardTone({ ...project, cardColor: 'url(x)' }, now), 'red');
  assert.equal(projectCardTone({ deadline: hoursFromNow(60) }, now), 'orange');
  assert.equal(projectCardTone({}, now), 'default');
});

test('converts displayed Beijing datetime input to an explicit UTC timestamp and back', () => {
  assert.equal(deadlineFromInput('2026-10-24T10:00'), '2026-10-24T02:00:00.000Z');
  assert.equal(deadlineInputValue('2026-10-23T16:00:00Z'), '2026-10-24T00:00');
  assert.equal(deadlineInputValue('2026-10-24T10:00:00+08:00'), '2026-10-24T10:00');
  assert.equal(deadlineFromInput(''), '');
  assert.equal(deadlineInputValue('invalid'), '');
  assert.throws(() => deadlineFromInput('2026-02-30T10:00'));
  assert.throws(() => deadlineFromInput('2026-10-24'));
});
