import { decryptConnectionSecret, encryptConnectionSecret, encryptionReady } from './connection-config.ts';
import { DomainError } from './domain.ts';

export interface MineruConnectionSnapshot {
  configured: boolean;
  storageReady: boolean;
  source: 'account' | 'environment' | 'none';
  version: number;
}

interface MineruEnvironment {
  DB?: D1Database;
  CONFIG_ENCRYPTION_KEY?: string;
  MINERU_API_TOKEN?: string;
}

interface MineruRow { secret_ciphertext: string; version: number; }

const kind = 'mineru';
const conflict = () => new DomainError('MinerU 配置已更新，请重新加载后重试。', 409);

function parseToken(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) return null;
  const token = value.trim();
  return /^[\x21-\x7e]+$/.test(token) ? token : null;
}

export function createMineruStore(environment: MineruEnvironment) {
  const { DB: db, CONFIG_ENCRYPTION_KEY: key } = environment;
  const keyReady = encryptionReady(key);
  const environmentToken = parseToken(environment.MINERU_API_TOKEN);

  async function row(ownerId: string): Promise<MineruRow | null> {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 512) throw new DomainError('请先登录工作台。', 401);
    if (!db) return null;
    try {
      return await db.prepare('SELECT secret_ciphertext, version FROM workbench_api_connections WHERE user_id = ? AND kind = ?').bind(ownerId, kind).first<MineruRow>();
    } catch {
      throw new DomainError('暂时无法读取 MinerU 配置，请稍后重试。', 503);
    }
  }

  async function effectiveToken(ownerId: string): Promise<string | null> {
    const saved = await row(ownerId);
    if (!keyReady) return null;
    if (!saved) return environmentToken;
    const token = parseToken(await decryptConnectionSecret(saved.secret_ciphertext, key, ownerId, kind));
    if (!token) throw new DomainError('MinerU API Token 无法读取，请在服务连接中重新保存。', 503);
    return token;
  }

  async function snapshot(ownerId: string): Promise<MineruConnectionSnapshot> {
    const saved = await row(ownerId);
    const source = saved ? 'account' : environmentToken ? 'environment' : 'none';
    return { configured: keyReady && source !== 'none', storageReady: Boolean(db && keyReady), source, version: saved?.version ?? 0 };
  }

  async function execute(ownerId: string, value: unknown): Promise<MineruConnectionSnapshot> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('MinerU 配置格式不正确。');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(field => !['action', 'version', 'token'].includes(field))) throw new DomainError('MinerU 仅支持官方云服务。');
    if ((input.action !== 'save' && input.action !== 'remove') || typeof input.version !== 'number' || !Number.isSafeInteger(input.version) || input.version < 0) {
      throw new DomainError('MinerU 配置操作或版本无效。');
    }
    if (!db || !keyReady) throw new DomainError('API 配置加密存储尚未启用，请联系管理员。', 503);
    const saved = await row(ownerId);
    if (input.version !== (saved?.version ?? 0)) throw conflict();

    if (input.action === 'remove') {
      if (saved) {
        const result = await db.prepare('DELETE FROM workbench_api_connections WHERE user_id = ? AND kind = ? AND version = ?').bind(ownerId, kind, saved.version).run();
        if (result.meta.changes !== 1) throw conflict();
      }
      return snapshot(ownerId);
    }

    const token = parseToken(input.token);
    if (!token) throw new DomainError('请填写有效的 MinerU API Token。');
    const ciphertext = await encryptConnectionSecret(token, key, ownerId, kind);
    const version = Date.now() * 1024 + crypto.getRandomValues(new Uint32Array(1))[0];
    const updatedAt = new Date().toISOString();
    const result = saved
      ? await db.prepare('UPDATE workbench_api_connections SET secret_ciphertext = ?, version = ?, updated_at = ? WHERE user_id = ? AND kind = ? AND version = ?').bind(ciphertext, version, updatedAt, ownerId, kind, saved.version).run()
      : await db.prepare("INSERT INTO workbench_api_connections (user_id, kind, enabled, base_url, model_name, secret_ciphertext, version, updated_at) VALUES (?, ?, 1, 'https://mineru.net', '', ?, ?, ?) ON CONFLICT(user_id, kind) DO NOTHING").bind(ownerId, kind, ciphertext, version, updatedAt).run();
    if (result.meta.changes !== 1) throw conflict();
    return { configured: true, storageReady: true, source: 'account', version };
  }

  return { snapshot, effectiveToken, execute };
}

async function runtimeStore() {
  const { env } = await import('cloudflare:workers');
  return createMineruStore(env as MineruEnvironment);
}

export async function readMineruConnection(ownerId: string) {
  return (await runtimeStore()).snapshot(ownerId);
}

export async function writeMineruConnection(ownerId: string, input: unknown) {
  return (await runtimeStore()).execute(ownerId, input);
}

export async function readEffectiveMineruToken(ownerId: string): Promise<string | null> {
  return (await runtimeStore()).effectiveToken(ownerId);
}
