import type { FactoryDocument, FactoryRecord } from './content-factory-types.ts';
import { DomainError } from './domain.ts';

type FactoryRow = { id: string; version: number; updated_at: string; document_json: string };
const initialized = new WeakMap<D1Database, Promise<unknown>>();

function ensureFactoryTable(db: D1Database) {
  const existing = initialized.get(db);
  if (existing) return existing;
  const creation = db.prepare(`
    CREATE TABLE IF NOT EXISTS workbench_content_factory_campaigns (
      owner_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      PRIMARY KEY (owner_id, member_id, id)
    )
  `).run().catch(error => {
    initialized.delete(db);
    throw error;
  });
  initialized.set(db, creation);
  return creation;
}

function toRecord(row: FactoryRow): FactoryRecord {
  return { id: row.id, version: row.version, updatedAt: row.updated_at, document: JSON.parse(row.document_json) as FactoryDocument };
}

export async function listFactoryCampaigns(db: D1Database, owner: string, member: string): Promise<FactoryRecord[]> {
  await ensureFactoryTable(db);
  const { results } = await db.prepare(`
    SELECT id,version,updated_at,document_json FROM workbench_content_factory_campaigns
    WHERE owner_id=? AND member_id=? ORDER BY updated_at DESC,id LIMIT 20
  `).bind(owner, member).all<FactoryRow>();
  return results.map(toRecord);
}

export async function saveFactoryCampaign(db: D1Database, owner: string, member: string, id: string, version: number, document: FactoryDocument): Promise<FactoryRecord> {
  await ensureFactoryTable(db);
  const updatedAt = new Date().toISOString();
  const json = JSON.stringify(document);
  const next = version + 1;
  const write = version === 0
    ? db.prepare(`
      INSERT INTO workbench_content_factory_campaigns (owner_id,member_id,id,version,updated_at,document_json)
      VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id,member_id,id) DO NOTHING
    `).bind(owner, member, id, next, updatedAt, json)
    : db.prepare(`
      UPDATE workbench_content_factory_campaigns SET version=?,updated_at=?,document_json=?
      WHERE owner_id=? AND member_id=? AND id=? AND version=?
    `).bind(next, updatedAt, json, owner, member, id, version);
  const result = await write.run();
  if (result.meta.changes === 1) return { id, version: next, updatedAt, document };
  const current = await db.prepare(`
    SELECT id,version,updated_at,document_json FROM workbench_content_factory_campaigns
    WHERE owner_id=? AND member_id=? AND id=?
  `).bind(owner, member, id).first<FactoryRow>();
  if (current?.version === next && current.document_json === json) return toRecord(current);
  throw new DomainError('活动已有新版本。请另存当前草稿，或重新打开历史活动。', 409);
}
