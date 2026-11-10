import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAgentMemoryStore } from '../app/lib/agent-memory-store.ts';
import type { MemoryNote, MemoryScope, MemoryTopic, MemoryTranscript } from '../app/lib/agent-memory-types.ts';

const personal: MemoryScope = { ownerId: 'owner', memberId: 'member', projectId: '' };
const project = { ...personal, projectId: 'project' };
const teammate = { ...personal, memberId: 'teammate' };
const outside = { ...personal, ownerId: 'outside' };
const at = '2026-11-11T01:00:00.000Z';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE workbench_member_accounts (owner_id TEXT, account_id TEXT, role TEXT, sales_id TEXT, enabled INTEGER);
    INSERT INTO workbench_member_accounts VALUES ('owner','member','manager',NULL,1),('owner','teammate','sales','sales-1',1),('outside','member','manager',NULL,1);
    CREATE TABLE workbench_workspaces (user_id TEXT, revision INTEGER, state_json TEXT);
    INSERT INTO workbench_workspaces VALUES ('owner',1,'old');`);
  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...bindings: unknown[]) { values = bindings; return this; },
        async first() { return sqlite.prepare(sql).get(...values as never[]) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values as never[]) }; },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values as never[]).changes) } }; },
      };
    },
    batch(items: { run(): Promise<unknown> }[]) {
      const result = tail.then(async () => {
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const item of items) results.push(await item.run());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      tail = result.catch(() => undefined);
      return result;
    },
  } as unknown as D1Database;
  let clock = Date.parse(at);
  const store = createAgentMemoryStore(db, () => clock);
  return { db, sqlite, store, advance: () => new Date(++clock).toISOString() };
}

function transcript(runId: string, createdAt = at): MemoryTranscript {
  return { runId, query: '以后先给行动清单，再解释背景。', answer: '收到。', createdAt, trace: '{"steps":[]}' };
}

function note(id: string, runId: string, topic = 'writing'): MemoryNote {
  return { id, runId, kind: 'preference', topic, title: '写作顺序', text: '先给行动清单。', quote: '先给行动清单', createdAt: at };
}

function page(sourceIds: string[], version = 0, topic = 'writing'): MemoryTopic {
  return { topic, title: '写作顺序', body: '先给行动清单。', sourceIds, updatedAt: at, version };
}

test('workspace CAS and active account guard both cover original transcript writes', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.store.ready();
  const sql = 'SELECT 1 FROM workbench_workspaces WHERE user_id=? AND revision=? AND state_json=?';
  const source = transcript('committed');
  await f.db.batch([
    f.store.transcriptStatement(personal, transcript('stale'), { sql, bindings: ['owner', 1, 'incorrect'] }),
    f.store.transcriptStatement(personal, source, { sql, bindings: ['owner', 1, 'old'] }),
    f.db.prepare("UPDATE workbench_workspaces SET revision=2 WHERE user_id='owner' AND revision=1"),
  ]);
  assert.equal(await f.store.appendTranscript(personal, transcript('committed')), false);
  assert.deepEqual(await f.store.transcripts(personal, ['stale', 'committed']), [source]);
  for (const scope of [project, teammate, outside]) assert.deepEqual(await f.store.transcripts(scope, ['committed']), []);
  await f.store.setEnabled(project, false);
  assert.equal(await f.store.isEnabled(personal), false);
  assert.equal(await f.store.isEnabled(teammate), true);
  assert.equal(await f.store.appendTranscript(project, transcript('disabled')), false);
  assert.deepEqual(await f.store.pendingScopes(10), []);
  f.sqlite.exec("UPDATE workbench_member_accounts SET enabled=0 WHERE account_id='teammate'");
  assert.equal(await f.store.appendTranscript(teammate, transcript('revoked')), false);
});

test('capture and offline consolidation are idempotent and source scoped', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.store.appendTranscript(project, transcript('project-turn'));
  await f.store.appendTranscript(teammate, transcript('other-turn'));
  assert.deepEqual(await f.store.pendingCount(project), { transcripts: 1, notes: 0 });
  assert.equal(await f.store.completeCapture(project, 'project-turn', [{ ...note('forged', 'project-turn'), quote: '用户没有说过' }]), false);
  assert.deepEqual(await f.store.pendingCount(project), { transcripts: 1, notes: 0 });
  const capture = () => f.store.completeCapture(project, 'project-turn', [note('pending', 'project-turn')]);
  assert.deepEqual((await Promise.all([capture(), capture()])).sort(), [false, true]);
  assert.deepEqual(await f.store.pendingCount(project), { transcripts: 0, notes: 1 });
  const bad = { examinedNoteIds: ['pending'], upsert: [page(['other-turn'])], remove: [] };
  assert.equal(await f.store.applyDream(project, bad), false);
  assert.equal((await f.store.pendingNotes(project, 5)).length, 1);
  const valid = { ...bad, upsert: [page(['project-turn'])] };
  const publish = () => f.store.applyDream(project, valid);
  assert.deepEqual((await Promise.all([publish(), publish()])).sort(), [false, true]);
  assert.deepEqual(await f.store.topics(project, 5), [page(['project-turn'], 1)]);
  assert.deepEqual(await f.store.topics(teammate, 5), []);
  assert.equal((await f.store.pendingNotes(project, 5)).length, 0);
});

test('scheduled scopes ignore pending project work after a sales assignment changes', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const assigned = { ...teammate, projectId: 'project' };
  const state = (ownerId: string) => JSON.stringify({ deals: [{ id: 'project', ownerId }] });
  f.sqlite.prepare("UPDATE workbench_workspaces SET state_json=? WHERE user_id='owner'").run(state('sales-1'));
  await f.store.appendTranscript(assigned, transcript('sales-turn'));
  await f.store.appendTranscript(project, transcript('manager-turn'));
  assert.deepEqual(await f.store.pendingScopes(5), [project, assigned]);
  f.sqlite.prepare("UPDATE workbench_workspaces SET state_json=? WHERE user_id='owner'").run(state('other-sales'));
  assert.deepEqual(await f.store.pendingScopes(5), [project]);
});

test('scoped search recalls older topics and ranks matching titles above body-only hits', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.store.appendTranscript(project, transcript('old'));
  await f.store.completeCapture(project, 'old', [note('old-note', 'old')]);
  const old = { ...page(['old'], 0, 'original'), title: '写作顺序', body: '先给行动清单。' };
  assert.equal(await f.store.applyDream(project, { examinedNoteIds: ['old-note'], upsert: [old], remove: [] }), true);
  const fresh = f.advance();
  await f.store.appendTranscript(project, transcript('new', fresh));
  await f.store.completeCapture(project, 'new', [note('new-note', 'new')]);
  const upsert = Array.from({ length: 25 }, (_, index) => ({ ...page(['new'], 0, `new-${index}`), title: `工作方式 ${index}`, body: '有时需要复查写作顺序。' }));
  assert.equal(await f.store.applyDream(project, { examinedNoteIds: ['new-note'], upsert, remove: [] }), true);
  assert.equal((await f.store.topics(project, 24)).some(item => item.topic === 'original'), false);
  assert.equal((await f.store.findTopics(project, ['写作顺序'], 2))[0]?.topic, 'original');
  assert.equal((await f.store.topic(project, 'original'))?.body, old.body);
  assert.equal(await f.store.topic(personal, 'original'), null);
  assert.deepEqual(await f.store.findTopics(teammate, ['写作顺序'], 2), []);
});

test('forgetting blocks in-flight consolidation and late extraction from older source records', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.store.appendTranscript(project, transcript('saved'));
  await f.store.appendTranscript(project, transcript('late-capture'));
  await f.store.completeCapture(project, 'saved', [note('saved-note', 'saved'), note('alias-note', 'saved', 'alias')]);
  await f.store.applyDream(project, { examinedNoteIds: ['saved-note'], upsert: [page(['saved'])], remove: [] });
  const forgetTime = f.advance();
  assert.equal(await f.store.forgetTopic(project, 'writing', 0), false);
  assert.equal(await f.store.forgetTopic(project, 'writing', 1), true);
  await f.store.completeCapture(project, 'late-capture', [note('old', 'late-capture')]);
  assert.deepEqual(await f.store.pendingNotes(project, 5), []);
  assert.deepEqual(await f.store.recentNotes(project, 5), []);
  assert.deepEqual(await f.store.topics(project, 5), []);
  assert.equal((await f.store.transcripts(project, ['saved'])).length, 1);
  assert.deepEqual(await f.store.evidenceTranscripts(project, ['saved']), []);
  const freshTime = f.advance();
  assert.ok(freshTime > forgetTime);
  await f.store.appendTranscript(project, transcript('new', freshTime));
  await f.store.completeCapture(project, 'new', [note('new-note', 'new')]);
  const stale = { examinedNoteIds: ['new-note'], upsert: [page(['saved'], 0)], remove: [] };
  assert.equal(await f.store.applyDream(project, stale), false);
  assert.equal(await f.store.applyDream(project, { ...stale, upsert: [page(['saved'], 0, 'renamed')] }), false);
  assert.equal(await f.store.applyDream(project, { ...stale, upsert: [page(['new'])] }), true);
  assert.equal((await f.store.topics(project, 5))[0]?.version, 3);
});
