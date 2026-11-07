/** Calendar arithmetic uses UTC date-only values; instants are explicitly Asia/Shanghai. */
export type CalendarMode = 'week' | 'month' | 'list';
export type CalendarInterval = { startAt: string | null; endAt: string | null; allDay: boolean };
export const SHANGHAI_ZONE = 'Asia/Shanghai';
const DAY = 86_400_000;
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: SHANGHAI_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: SHANGHAI_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function dateNumber(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期格式无效');
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new Error('日期无效');
  return parsed;
}
export function shanghaiDate(value: string | number | Date = Date.now()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('时间无效');
  const parts = dateFormatter.formatToParts(date);
  const read = (type: string) => parts.find(part => part.type === type)!.value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}
export function shanghaiTime(value: string): string { return timeFormatter.format(new Date(value)); }
export function addCalendarDays(value: string, count: number): string {
  return new Date(dateNumber(value) + count * DAY).toISOString().slice(0, 10);
}
export function mondayOf(value: string): string {
  const day = new Date(dateNumber(value)).getUTCDay();
  return addCalendarDays(value, -(day === 0 ? 6 : day - 1));
}
export function addCalendarMonths(value: string, count: number): string {
  const date = new Date(dateNumber(value));
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString().slice(0, 10);
}
export function calendarRange(anchor: string, mode: CalendarMode): { from: string; to: string; days: string[] } {
  let from = mondayOf(anchor);
  let to = addCalendarDays(from, 7);
  if (mode === 'month') {
    const first = `${anchor.slice(0, 7)}-01`;
    from = mondayOf(first);
    const next = addCalendarMonths(first, 1);
    to = mondayOf(next);
    if (to < next) to = addCalendarDays(to, 7);
  }
  const days: string[] = [];
  for (let day = from; day < to; day = addCalendarDays(day, 1)) days.push(day);
  return { from, to, days };
}
export function shanghaiInstant(date: string, time = '00:00'): string {
  dateNumber(date);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('时间格式无效');
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}
/** Intervals are half-open: an end at midnight never leaks into the following day. */
export function occursOnDate(item: CalendarInterval, day: string): boolean {
  if (!item.startAt) return false;
  const start = Date.parse(item.startAt);
  const end = item.endAt ? Date.parse(item.endAt) : start;
  const dayStart = Date.parse(shanghaiInstant(day));
  const dayEnd = Date.parse(shanghaiInstant(addCalendarDays(day, 1)));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (end <= start) return start >= dayStart && start < dayEnd;
  return start < dayEnd && end > dayStart;
}
export function calendarDateLabel(day: string, includeYear = false): string {
  dateNumber(day);
  const [year, month, date] = day.split('-').map(Number);
  return `${includeYear ? `${year}年` : ''}${month}月${date}日`;
}
export function intervalLabel(item: CalendarInterval, day?: string): string {
  if (!item.startAt) return '待安排时间';
  const startDay = shanghaiDate(item.startAt);
  const endDay = item.endAt ? shanghaiDate(item.endAt) : startDay;
  if (item.allDay) {
    const last = item.endAt ? addCalendarDays(endDay, -1) : startDay;
    return last > startDay ? `${calendarDateLabel(startDay)}–${calendarDateLabel(last)} · 全天` : '全天';
  }
  const start = shanghaiTime(item.startAt);
  const end = item.endAt ? shanghaiTime(item.endAt) : '';
  if (startDay !== endDay) return `${calendarDateLabel(startDay)} ${start}–${calendarDateLabel(endDay)} ${end}`;
  return day && day > startDay ? '延续日程' : `${start}${end ? `–${end}` : ''}`;
}
