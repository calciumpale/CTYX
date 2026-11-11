import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createCreativeStudioStore } from '../app/lib/creative-studio-store.ts';
import { assertMemberApi } from '../app/lib/member-policy.ts';
import { emptyStudioCopy } from '../app/lib/creative-studio-types.ts';
import type { StudioDocument, StudioLayer } from '../app/lib/creative-studio-types.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: never[] = [];
      const run = () => ({ meta: { changes: Number(statement.run(...values).changes) } });
      return {
        bind(...args: never[]) { values = args; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return run(); },
        runInBatch: run,
      };
    },
    async batch(statements: { runInBatch: () => unknown }[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.runInBatch());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sqlite, store: createCreativeStudioStore(db) };
}

test('creative studio belongs to business members', () => {
  assert.doesNotThrow(() => assertMemberApi('sales', '/api/creative-studio', 'GET'));
  assert.doesNotThrow(() => assertMemberApi('manager', '/api/creative-studio', 'POST'));
  assert.throws(() => assertMemberApi('admin', '/api/creative-studio', 'GET'), { status: 403 });
});

test('explicit saves create immutable versions, reject stale divergent writes, and isolate private drafts', async t => {
  const { sqlite, store } = fixture();
  t.after(() => sqlite.close());
  const initial = document('首版');
  const second = { ...initial, title: '第二版' };
  const id = 'creative-project-one';
  const saved = await store.save('tenant', 'member', id, 0, initial);
  assert.equal(saved.version, 1);
  assert.equal((await store.save('tenant', 'member', id, 0, initial)).version, 1);
  assert.equal((await store.save('tenant', 'member', id, 1, second)).version, 2);
  await assert.rejects(store.save('tenant', 'member', id, 1, { ...initial, title: '冲突版本' }), { status: 409 });
  assert.deepEqual((await store.get('tenant', 'member', id, 1)).document, initial);
  assert.deepEqual((await store.get('tenant', 'member', id)).document, second);
  assert.deepEqual((await store.versions('tenant', 'member', id)).map(item => item.version), [2, 1]);
  assert.deepEqual(await store.list('tenant', 'other-member'), []);
  await assert.rejects(store.get('tenant', 'other-member', id), { status: 404 });
  await assert.rejects(store.get('other-tenant', 'member', id, 1), { status: 404 });
  await assert.rejects(store.archive('tenant', 'member', id, 1), { status: 409 });
  await store.archive('tenant', 'member', id, 2);
  await store.archive('tenant', 'member', id, 2);
  await assert.rejects(store.archive('tenant', 'other-member', id, 2), { status: 404 });
  assert.deepEqual(await store.list('tenant', 'member'), []);
  await assert.rejects(store.get('tenant', 'member', id), { status: 404 });
  await assert.rejects(store.save('tenant', 'member', id, 0, initial), { status: 409 });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM workbench_creative_versions').get()?.count, 2);
});

const layer: StudioLayer = {
  id: 'layer-one', name: '标题', kind: 'text', text: '公开标题', assetUrl: '',
  x: 5, y: 5, width: 80, height: 20, fill: 'transparent', color: '#112233',
  fontSize: 48, radius: 0, weight: 'bold', align: 'left',
};
function document(title = '内部项目'): StudioDocument {
  return {
    title, kind: 'poster', brief: '私有沟通背景', audience: '内部目标受众', channel: '内部渠道',
    style: '内部风格', copy: { ...emptyStudioCopy(), caption: '私有营销草稿' },
    boards: [{ id: 'board-one', name: '版式', width: 1080, height: 1440, background: '#ffffff', layers: [layer] }],
  };
}

test('publishing shares only the explicit board snapshot with other members of the same owner', async t => {
  const { sqlite, store } = fixture();
  t.after(() => sqlite.close());
  const id = 'project-template';
  const initial = document();
  await store.save('tenant', 'author', id, 0, initial);
  await assert.rejects(store.publishTemplate('tenant', 'reader', id, 1, '模板', ''), { status: 404 });
  const first = await store.publishTemplate('tenant', 'author', id, 1, '模板', '公开说明');
  assert.equal(first.canRemove, true);
  const [visible] = await store.listTemplates('tenant', 'reader');
  assert.deepEqual(visible, { ...first, canRemove: false });
  assert.deepEqual(Object.keys(visible).sort(), ['boards', 'canRemove', 'description', 'id', 'kind', 'source', 'title']);
  assert.equal(JSON.stringify(visible).includes('私有'), false);
  assert.deepEqual(await store.listTemplates('other-tenant', 'reader'), []);
  await assert.rejects(store.removeTemplate('tenant', 'reader', first.id), { status: 404 });
  await assert.rejects(store.removeTemplate('other-tenant', 'author', first.id), { status: 404 });

  const boards = [{ ...initial.boards[0], name: '调整版式' }];
  await store.save('tenant', 'author', id, 1, { ...initial, boards });
  assert.equal((await store.listTemplates('tenant', 'reader'))[0].boards[0].name, '版式');
  await assert.rejects(store.publishTemplate('tenant', 'author', id, 1, '模板', ''), { status: 409 });
  const republished = await store.publishTemplate('tenant', 'author', id, 2, '模板', '新版');
  assert.equal(republished.id, first.id);
  assert.deepEqual(republished.boards, boards);

  const assetUrl = '/api/marketing-materials/result?taskId=private-material&fileIndex=0';
  await store.save('tenant', 'author', id, 2, { ...initial, boards: [{ ...boards[0], layers: [{ ...layer, kind: 'image', assetUrl }] }] });
  await assert.rejects(store.publishTemplate('tenant', 'author', id, 3, '模板', ''), { status: 400 });
  assert.deepEqual((await store.listTemplates('tenant', 'author'))[0], republished);
  await store.removeTemplate('tenant', 'author', first.id);
  assert.deepEqual(await store.listTemplates('tenant', 'reader'), []);
});

test('a failed version write rolls back the draft CAS', async t => {
  const { sqlite, store } = fixture();
  t.after(() => sqlite.close());
  const id = 'project-with-history';
  const initial = document();
  await store.save('tenant', 'author', id, 0, initial);
  sqlite.exec("CREATE TRIGGER deny_snapshot BEFORE INSERT ON workbench_creative_versions WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  await assert.rejects(store.save('tenant', 'author', id, 1, document('未保存')), /test failure/);
  assert.equal((await store.get('tenant', 'author', id)).version, 1);
  assert.deepEqual(await store.versions('tenant', 'author', id), [{ version: 1, updatedAt: (await store.get('tenant', 'author', id)).updatedAt }]);
});
