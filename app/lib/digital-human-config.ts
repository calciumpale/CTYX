import {DomainError} from './domain.ts';
import type {StoredDigitalHumanAsset, StoredDigitalHumanLive, DigitalHumanAsset, DigitalHumanLive} from './digital-human-types.ts';

export const PHOTO_LIMIT = 20 * 1024 * 1024;
export const VIDEO_LIMIT = 100 * 1024 * 1024;
export function digitalHumanText(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || required && !value.trim()) throw new DomainError('数字人参数格式或长度无效');
  return value.trim();
}
export function digitalHumanScript(value: unknown): string {
  if (typeof value !== 'string' || value.length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new DomainError('播报脚本格式无效');
  const script = value.replace(/\r\n?/g, '\n').trim();
  if (!script || Array.from(script).length > 300) throw new DomainError('播报脚本最多300个字符');
  return script;
}
export function digitalHumanId(value: unknown): string {
  const text = digitalHumanText(value, 200);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(text)) throw new DomainError('数字人标识无效');
  return text;
}
export function digitalHumanRequestId(value: unknown): string {
  const text = digitalHumanText(value, 100);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(text)) throw new DomainError('提交标识无效');
  return text;
}
export function digitalHumanVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new DomainError('记录版本无效，请刷新后重试', 409);
  return Number(value);
}
export async function digitalHumanHash(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function digitalHumanPushUrl(value: unknown): {url: string; display: string} {
  const text = digitalHumanText(value, 4096);
  let url: URL;
  try { url = new URL(text); } catch { throw new DomainError('请填写有效的 RTMP/RTMPS 推流地址'); }
  if (!['rtmp:', 'rtmps:'].includes(url.protocol) || url.username || url.password || url.hash || !url.pathname || url.pathname === '/' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/i.test(url.hostname)) throw new DomainError('推流地址须为有效公网域名的 RTMP/RTMPS 地址');
  return {url: url.href, display: `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}/…`};
}
export function publicDigitalHumanAsset(asset: StoredDigitalHumanAsset): DigitalHumanAsset {
  const {id, requestId, version, name, sourceKind, status, fileName, mime, size, digitalHumanId, digitalHumanName, createdAt, updatedAt, error} = asset;
  return {id, requestId, version, name, sourceKind, status, ...(fileName ? {fileName, mime, size} : {}), ...(asset.fileKey ? {sourceUrl: `/api/digital-humans/source?assetId=${encodeURIComponent(id)}`} : {}), ...(digitalHumanId ? {digitalHumanId, digitalHumanName} : {}), createdAt, updatedAt, ...(error ? {error} : {})};
}
export function publicDigitalHumanLive(live: StoredDigitalHumanLive): DigitalHumanLive {
  const {id, requestId, version, assetId, name, platform, pushUrlDisplay, status, providerState, lastCommand, createdAt, updatedAt, error} = live;
  return {id, requestId, version, assetId, name, platform, pushUrlDisplay, hasPushUrl: !!live.pushCiphertext, status, hasInstance: !!live.providerInstanceId, ...(live.generationRequestId ? {generationId: live.generationRequestId} : {}), ...(providerState ? {providerState} : {}), ...(lastCommand ? {lastCommand} : {}), createdAt, updatedAt, ...(error ? {error} : {})};
}
export async function readDigitalHumanBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new DomainError('请使用 JSON 提交数字人参数', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new DomainError('缺少数字人参数');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 32768) { await reader.cancel(); throw new DomainError('数字人参数过大', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new DomainError('数字人参数格式无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('数字人参数格式无效');
  return value as Record<string, unknown>;
}
