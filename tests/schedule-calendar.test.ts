import assert from 'node:assert/strict';
import test from 'node:test';
import { addCalendarDays, addCalendarMonths, calendarRange, intervalLabel, mondayOf, occursOnDate, shanghaiDate, shanghaiInstant, shanghaiTime } from '../app/lib/schedule-calendar.ts';

test('Shanghai date changes precisely at UTC16:00, independently of host timezone', () => {
  assert.equal(shanghaiDate('2026-11-06T15:59:59Z'), '2026-11-06');
  assert.equal(shanghaiDate('2026-11-06T16:00:00Z'), '2026-11-07');
  assert.equal(shanghaiTime('2026-11-06T16:00:00Z'), '00:00');
  assert.equal(shanghaiInstant('2026-11-07', '09:30'), '2026-11-07T01:30:00.000Z');
});
test('Monday weeks span year boundaries and Sunday belongs to preceding Monday', () => {
  assert.equal(mondayOf('2027-01-03'), '2026-12-28');
  assert.equal(mondayOf('2027-01-04'), '2027-01-04');
  assert.deepEqual(calendarRange('2027-01-01', 'week').days, ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  assert.equal(calendarRange('2027-01-01', 'list').to, '2027-01-04');
});
test('month navigation clamps end of month and handles leap and year boundaries', () => {
  assert.equal(addCalendarMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addCalendarMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addCalendarMonths('2026-12-31', 1), '2027-01-31');
  assert.equal(addCalendarDays('2028-02-28', 2), '2028-03-01');
  const grid = calendarRange('2026-11-07', 'month');
  assert.equal(grid.from, '2026-10-26');
  assert.equal(grid.to, '2026-12-07');
  assert.equal(grid.days.length, 42);
  assert.equal(calendarRange('2027-02-15', 'month').days.length, 28);
});
test('half-open multi-day events occupy only overlapping Shanghai dates', () => {
  const event = { startAt: shanghaiInstant('2026-12-31', '23:30'), endAt: shanghaiInstant('2027-01-02'), allDay: false };
  assert.equal(occursOnDate(event, '2026-12-30'), false);
  assert.equal(occursOnDate(event, '2026-12-31'), true);
  assert.equal(occursOnDate(event, '2027-01-01'), true);
  assert.equal(occursOnDate(event, '2027-01-02'), false);
  const allDay = { startAt: shanghaiInstant('2027-01-01'), endAt: shanghaiInstant('2027-01-03'), allDay: true };
  assert.equal(occursOnDate(allDay, '2026-12-31'), false);
  assert.equal(occursOnDate(allDay, '2027-01-02'), true);
  assert.equal(occursOnDate(allDay, '2027-01-03'), false);
  assert.equal(intervalLabel(allDay), '1月1日–1月2日 · 全天');
});
test('single instants and unscheduled records do not appear on adjacent days', () => {
  const point = { startAt: shanghaiInstant('2026-11-07'), endAt: null, allDay: false };
  assert.equal(occursOnDate(point, '2026-11-06'), false);
  assert.equal(occursOnDate(point, '2026-11-07'), true);
  assert.equal(occursOnDate(point, '2026-11-08'), false);
  assert.equal(occursOnDate({ ...point, startAt: null }, '2026-11-07'), false);
  assert.equal(occursOnDate({ ...point, startAt: 'bad' }, '2026-11-07'), false);
});
test('rejects rollover dates and invalid times instead of silently shifting them', () => {
  assert.throws(() => shanghaiInstant('2026-02-30'));
  assert.throws(() => addCalendarDays('2026-13-01', 1));
  assert.throws(() => shanghaiInstant('2026-11-07', '24:00'));
});
