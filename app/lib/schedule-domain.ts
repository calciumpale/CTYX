import { DomainError } from './domain.ts';
import type { ScheduleDraft, ScheduleKind, ScheduleStatus } from './schedule-types.ts';

const DAY = 86400000;
const fail = (message: string): never => { throw new DomainError(message, 400); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('日程格式不正确');
  return value as Record<string, unknown>;
};
/** Validate the civil components before constructing an instant; Date.parse rolls February 30 forward. */
function civil(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 4) === '0000') fail('日期请使用有效的 YYYY-MM-DD 格式');
  const value = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) fail('日期不存在');
}
export function scheduleDate(date: string): string {
  if (typeof date !== 'string') return fail('日期格式不正确');
  civil(date);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - 8 * 3600000).toISOString();
}
export function scheduleDay(instant: string): string {
  if (typeof instant !== 'string' || !Number.isFinite(Date.parse(instant))) return fail('日程时间无效');
  return new Date(Date.parse(instant) + 8 * 3600000).toISOString().slice(0, 10);
}
export function scheduleRange(from: string, to: string): { start: string; end: string } {
  const start = scheduleDate(from), end = scheduleDate(to);
  const days = (Date.parse(end) - Date.parse(start)) / DAY;
  if (days <= 0 || days > 62) fail('日程查询范围须为1至62天，结束日期不包含当天');
  return { start, end };
}
function instant(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 40) return fail('时间须包含明确的 UTC 或时区偏移');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return fail('时间须包含明确的 UTC 或时区偏移');
  civil(match[1]);
  if (+match[2] > 23 || +match[3] > 59 || +match[4] > 59) return fail('日程时间不存在');
  if (match[6] !== 'Z') {
    const hour = +match[6].slice(1, 3), minute = +match[6].slice(4, 6);
    if (hour > 14 || minute > 59 || hour === 14 && minute !== 0) fail('时区偏移无效');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return fail('日程时间无效');
  return new Date(ms).toISOString();
}
function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return fail(`${label}格式或长度不正确`);
  const normalized = value.trim();
  if (required && !normalized) fail(`请填写${label}`);
  return normalized;
}
export function scheduleId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) return fail('日程或项目编号无效');
  return value;
}
export function scheduleVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail('日程版本无效，请刷新重试');
  return value as number;
}
export function scheduleStatus(value: unknown): ScheduleStatus {
  if (typeof value !== 'string' || !['pending', 'completed', 'cancelled'].includes(value)) return fail('日程状态无效');
  return value as ScheduleStatus;
}
export function normalizeScheduleDraft(value: unknown): ScheduleDraft {
  const input = record(value);
  const keys = ['kind', 'title', 'startAt', 'endAt', 'allDay', 'dealId', 'location', 'notes'];
  if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !(key in input))) fail('日程字段不完整或包含不支持的字段');
  if (typeof input.kind !== 'string' || !['task', 'event', 'visit'].includes(input.kind)) fail('日程类型无效');
  if (typeof input.allDay !== 'boolean') fail('全天设置无效');
  const startAt = instant(input.startAt), endAt = instant(input.endAt);
  if ((startAt === null) !== (endAt === null)) fail('开始和结束时间必须一起填写');
  if (startAt === null && (input.kind === 'event' || input.allDay)) fail('事件和全天日程需要明确的开始及结束时间');
  if (startAt && endAt) {
    if (Date.parse(endAt) <= Date.parse(startAt)) fail('结束时间必须晚于开始时间');
    if (input.allDay && [startAt, endAt].some(date => (Date.parse(date) + 8 * 3600000) % DAY !== 0)) fail('全天日程须从上海时间零点开始和结束，结束日期不包含当天');
  }
  return { kind: input.kind as ScheduleKind, title: text(input.title, '日程标题', 120, true), startAt, endAt, allDay: input.allDay as boolean,
    dealId: input.dealId === null ? null : scheduleId(input.dealId), location: text(input.location, '地点', 300), notes: text(input.notes, '备注', 4000) };
}
