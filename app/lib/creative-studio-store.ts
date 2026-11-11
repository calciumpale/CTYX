import { DomainError } from './domain.ts';
import { studioMarketBoards, studioText } from './creative-studio-validation.ts';
import type { StudioBoard, StudioDocument, StudioKind, StudioRecord, StudioSummary, StudioTemplate, StudioVersion } from './creative-studio-types.ts';

interface ProjectRow {
  id: string;
  title: string;
  kind: StudioKind;
  version: number;
  updated_at: string;
  document_json: string;
}
interface TemplateRow {
  id: string;
  member_id: string;
  title: string;
  kind: StudioKind;
  description: string;
  boards_json: string;
}

const notFound = () => new DomainError('创作项目不存在或已归档', 404);
const conflict = () => new DomainError('项目版本已更新，请重新打开项目后再试', 409);
const now = () => new Date().toISOString();

function projectRecord(row: Pick<ProjectRow, 'id' | 'version' | 'updated_at' | 'document_json'>): StudioRecord {
  return { id: row.id, document: JSON.parse(row.document_json) as StudioDocument, version: row.version, updatedAt: row.updated_at };
}

function marketRecord(row: TemplateRow, member: string): StudioTemplate {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    description: row.description,
    boards: JSON.parse(row.boards_json) as StudioBoard[],
    source: 'workspace',
    canRemove: row.member_id === member,
  };
}

export function createCreativeStudioStore(db: D1Database) {
  const find = (owner: string, member: string, id: string) => db.prepare(
    'SELECT id,title,kind,version,updated_at,document_json FROM workbench_creative_projects WHERE owner_id=? AND member_id=? AND id=? AND archived_at IS NULL',
  ).bind(owner, member, id).first<ProjectRow>();

  async function get(owner: string, member: string, id: string, version?: number): Promise<StudioRecord> {
    const row = version === undefined ? await find(owner, member, id) : await db.prepare(
      `SELECT p.id,v.version,v.updated_at,v.document_json FROM workbench_creative_versions v
       JOIN workbench_creative_projects p ON p.owner_id=v.owner_id AND p.member_id=v.member_id AND p.id=v.project_id
       WHERE v.owner_id=? AND v.member_id=? AND v.project_id=? AND v.version=? AND p.archived_at IS NULL`,
    ).bind(owner, member, id, version).first<ProjectRow>();
    if (!row) throw notFound();
    return projectRecord(row);
  }

  async function list(owner: string, member: string): Promise<StudioSummary[]> {
    const { results } = await db.prepare(
      'SELECT id,title,kind,version,updated_at FROM workbench_creative_projects WHERE owner_id=? AND member_id=? AND archived_at IS NULL ORDER BY updated_at DESC,id',
    ).bind(owner, member).all<Omit<ProjectRow, 'document_json'>>();
    return results.map(row => ({ id: row.id, title: row.title, kind: row.kind, version: row.version, updatedAt: row.updated_at }));
  }

  async function versions(owner: string, member: string, id: string, maxVersion = Number.MAX_SAFE_INTEGER): Promise<StudioVersion[]> {
    const { results } = await db.prepare(
      `SELECT v.version,v.updated_at FROM workbench_creative_versions v
       JOIN workbench_creative_projects p ON p.owner_id=v.owner_id AND p.member_id=v.member_id AND p.id=v.project_id
       WHERE v.owner_id=? AND v.member_id=? AND v.project_id=? AND v.version<=? AND p.archived_at IS NULL ORDER BY v.version DESC`,
    ).bind(owner, member, id, maxVersion).all<Pick<ProjectRow, 'version' | 'updated_at'>>();
    return results.map(row => ({ version: row.version, updatedAt: row.updated_at }));
  }

  async function save(owner: string, member: string, id: string, expected: number, document: StudioDocument): Promise<StudioRecord> {
    const nextVersion = expected + 1;
    const json = JSON.stringify(document);
    const at = now();
    const token = crypto.randomUUID();
    const write = expected === 0
      ? db.prepare(
        `INSERT INTO workbench_creative_projects (owner_id,member_id,id,title,kind,version,updated_at,save_token,document_json)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,member_id,id) DO NOTHING`,
      ).bind(owner, member, id, document.title, document.kind, nextVersion, at, token, json)
      : db.prepare(
        `UPDATE workbench_creative_projects SET title=?,kind=?,version=?,updated_at=?,save_token=?,document_json=?
         WHERE owner_id=? AND member_id=? AND id=? AND version=? AND archived_at IS NULL`,
      ).bind(document.title, document.kind, nextVersion, at, token, json, owner, member, id, expected);
    // The token matches only this successful CAS. D1 rolls back both statements if the history insert fails.
    const snapshot = db.prepare(
      `INSERT INTO workbench_creative_versions (owner_id,member_id,project_id,version,updated_at,document_json)
       SELECT owner_id,member_id,id,version,updated_at,document_json FROM workbench_creative_projects
       WHERE owner_id=? AND member_id=? AND id=? AND save_token=?`,
    ).bind(owner, member, id, token);
    const [changed] = await db.batch([write, snapshot]);
    if (changed.meta.changes === 1) return { id, document, version: nextVersion, updatedAt: at };

    const current = await find(owner, member, id);
    if (current?.version === nextVersion && current.document_json === json) return projectRecord(current);
    if (!current && expected > 0) throw notFound();
    throw conflict();
  }

  async function archive(owner: string, member: string, id: string, expected: number): Promise<void> {
    const at = now();
    const result = await db.prepare(
      `UPDATE workbench_creative_projects SET archived_at=?,updated_at=?
       WHERE owner_id=? AND member_id=? AND id=? AND version=? AND archived_at IS NULL`,
    ).bind(at, at, owner, member, id, expected).run();
    if (result.meta.changes === 1) return;
    const current = await db.prepare(
      'SELECT version,archived_at FROM workbench_creative_projects WHERE owner_id=? AND member_id=? AND id=?',
    ).bind(owner, member, id).first<{ version: number; archived_at: string | null }>();
    if (!current) throw notFound();
    if (current.archived_at && current.version === expected) return;
    throw conflict();
  }

  async function listTemplates(owner: string, member: string): Promise<StudioTemplate[]> {
    const { results } = await db.prepare(
      'SELECT id,member_id,title,kind,description,boards_json FROM workbench_creative_templates WHERE owner_id=? ORDER BY updated_at DESC,id',
    ).bind(owner).all<TemplateRow>();
    return results.map(row => marketRecord(row, member));
  }

  async function publishTemplate(owner: string, member: string, id: string, expected: number, title: string, description: string): Promise<StudioTemplate> {
    const project = await get(owner, member, id);
    if (project.version !== expected) throw conflict();
    const templateTitle = studioText(title, '模板标题', 120, true).trim();
    const templateDescription = studioText(description, '模板说明', 600).trim();
    const boards = studioMarketBoards(project.document.boards, templateTitle, templateDescription);
    const json = JSON.stringify(boards);
    const row = await db.prepare(
      `INSERT INTO workbench_creative_templates (id,owner_id,member_id,project_id,title,kind,description,boards_json,updated_at)
       SELECT ?,owner_id,member_id,id,?,kind,?,?,? FROM workbench_creative_projects
       WHERE owner_id=? AND member_id=? AND id=? AND version=? AND archived_at IS NULL
       ON CONFLICT(owner_id,member_id,project_id) DO UPDATE SET
         title=excluded.title,kind=excluded.kind,description=excluded.description,boards_json=excluded.boards_json,updated_at=excluded.updated_at
       RETURNING id,member_id,title,kind,description,boards_json`,
    ).bind(crypto.randomUUID(), templateTitle, templateDescription, json, now(), owner, member, id, expected).first<TemplateRow>();
    if (!row) throw conflict();
    return marketRecord(row, member);
  }

  async function removeTemplate(owner: string, member: string, id: string): Promise<void> {
    const result = await db.prepare(
      'DELETE FROM workbench_creative_templates WHERE owner_id=? AND member_id=? AND id=?',
    ).bind(owner, member, id).run();
    if (result.meta.changes !== 1) throw new DomainError('模板不存在或你没有移除权限', 404);
  }

  return { list, get, versions, save, archive, listTemplates, publishTemplate, removeTemplate };
}
