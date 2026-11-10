import { DomainError } from './domain.ts';
import { materialText } from './marketing-material.ts';
import { MOMENT_STYLES, type MomentDraft, type MomentPlanInput, type MomentStoredDraft, type MomentStyle } from './moments-types.ts';

const dailyTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const hour = 60 * 60 * 1000;

export function momentDay(now: string): string {
  return new Date(Date.parse(now) + 8 * hour).toISOString().slice(0, 10);
}
export function nextMomentAt(time: string, now: string): string {
  const day = momentDay(now);
  const scheduled = Date.parse(`${day}T${time}:00+08:00`);
  return new Date(scheduled > Date.parse(now) ? scheduled : scheduled + 24 * hour).toISOString();
}
export function parseMomentPlan(value: unknown): MomentPlanInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('朋友圈计划格式无效');
  const input = value as Record<string, unknown>;
  if (typeof input.style !== 'string' || !Object.hasOwn(MOMENT_STYLES, input.style)) throw new DomainError('请选择朋友圈风格');
  if (typeof input.time !== 'string' || !dailyTime.test(input.time)) throw new DomainError('请设置有效的北京时间');
  if (typeof input.enabled !== 'boolean' || typeof input.includeImage !== 'boolean') throw new DomainError('请选择计划和配图状态');
  return {
    productName: materialText(input.productName, 120, true),
    productDetails: materialText(input.productDetails, 2000, true),
    style: input.style as MomentStyle,
    time: input.time,
    enabled: input.enabled,
    includeImage: input.includeImage,
  };
}
export function momentId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(value)) throw new DomainError(`${label}无效`);
  return value;
}
export function momentVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new DomainError('朋友圈计划版本无效');
  return value;
}
export function publicMomentDraft(draft: MomentStoredDraft): MomentDraft {
  const { id, planId, productName, style, trigger, status, text, error, files, createdAt } = draft;
  return { id, planId, productName, style, trigger, status, text, error, files, createdAt };
}
