import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMomentStore } from '../app/lib/moments-store.ts';
import { createMomentService } from '../app/lib/moments-service.ts';
import type { PublicMaterialTask } from '../app/lib/marketing-material-types.ts';
import { memberRouteAccess } from '../app/lib/member-auth.ts';
import { assertMemberApi } from '../app/lib/member-policy.ts';

const start = '2026-11-09T23:00:00.000Z';
const due = '2026-11-10T00:30:00.000Z';
const product = { productName: '午后冷萃', productDetails: '冷萃咖啡与独立包装', style: 'business' as const, time: '08:30', enabled: true, includeImage: true };

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  const db = {
    prepare(sql: string) {
      let values: never[] = [];
      const run = () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } });
      return {
        bind(...args: never[]) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return run(); },
        runNow: run,
      };
    },
    async batch(statements: { runNow: () => unknown }[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.runNow());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  for (const [owner, member, role] of [['tenant', 'sales', 'sales'], ['tenant', 'manager', 'manager'], ['tenant', 'admin', 'admin'], ['other', 'other-member', 'sales']]) {
    sqlite.prepare('INSERT INTO workbench_member_accounts (owner_id,account_id,username,display_name,role,sales_id,password_salt,password_hash,password_iterations,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(owner, member, member, member, role, role === 'sales' ? member : null, '', '', 1, start, start);
  }
  return { sqlite, store: createMomentStore(db) };
}

test('daily moments use the plan’s Shanghai time, queue once per local day, and ignore disabled members', async t => {
  const { sqlite, store } = fixture();
  t.after(() => sqlite.close());
  const plan = await store.savePlan('tenant', 'sales', product, undefined, start);
  assert.equal(plan.nextRunAt, due);
  assert.deepEqual(await store.queueDue('2026-11-10T00:29:59.999Z'), []);
  const parallel = await Promise.all([store.queueDue(due), store.queueDue(due)]);
  const [draft] = parallel.flat();
  assert.equal(parallel.flat().length, 1);
  assert.equal(draft.planId, plan.id);
  assert.equal(draft.trigger, 'daily');
  assert.equal(draft.input.productName, product.productName);
  const [advanced] = await store.listPlans('tenant', 'sales');
  assert.equal(advanced.nextRunAt, '2026-11-11T00:30:00.000Z');
  const edited = await store.savePlan('tenant', 'sales', { ...product, time: '09:00' }, advanced, due);
  assert.equal(edited.nextRunAt, '2026-11-10T01:00:00.000Z');
  assert.deepEqual(await store.queueDue(edited.nextRunAt!), []);
  assert.equal((await store.listDrafts('tenant', 'sales')).length, 1);
  sqlite.prepare('UPDATE workbench_member_accounts SET enabled=0 WHERE account_id=?').run('sales');
  assert.deepEqual(await store.queueDue('2026-11-11T01:00:00.000Z'), []);
  assert.deepEqual(await store.listRunnable('2026-11-11T01:00:00.000Z'), []);
  await assert.rejects(store.savePlan('tenant', 'admin', product, undefined, start), { status: 403 });
});

test('manual requests retain a private product snapshot and stale workers cannot overwrite a draft', async t => {
  const { sqlite, store } = fixture();
  t.after(() => sqlite.close());
  const plan = await store.savePlan('tenant', 'manager', { ...product, enabled: false }, undefined, start);
  const draft = await store.queueManual('tenant', 'manager', plan.id, 'request-0001', start);
  const updated = await store.savePlan('tenant', 'manager', { ...product, productName: '更新的产品' }, plan, start);
  assert.equal((await store.queueManual('tenant', 'manager', plan.id, 'request-0001', start)).id, draft.id);
  await assert.rejects(store.queueManual('tenant', 'manager', plan.id, 'request-0002', start), { status: 409 });
  assert.equal(draft.input.productName, product.productName);
  assert.deepEqual(await store.listDrafts('tenant', 'sales'), []);
  await assert.rejects(store.getDraft('other', 'other-member', draft.id), { status: 404 });
  await assert.rejects(store.queueManual('tenant', 'sales', plan.id, 'request-0002', start), { status: 404 });
  await store.archivePlan('tenant', 'manager', plan.id, updated.version, start);
  assert.deepEqual(await store.listPlans('tenant', 'manager'), []);
  await assert.rejects(store.queueManual('tenant', 'manager', plan.id, 'request-0003', start), { status: 404 });
  const lease = (await store.reserveDraft(draft, start))!;
  assert.ok(lease.leaseToken);
  assert.equal(lease.status, 'writing');
  assert.equal(await store.reserveDraft(draft, start), null);
  const afterLease = '2026-11-10T00:00:00.000Z';
  const [runnable] = await store.listRunnable(afterLease, 5, { ownerId: 'tenant', memberId: 'manager' });
  const reclaimed = (await store.reserveDraft(runnable, afterLease))!;
  assert.notEqual(reclaimed.leaseToken, lease.leaseToken);
  await assert.rejects(store.saveDraft(lease, { status: 'completed' }, afterLease), { status: 409 });
  const result = await store.saveDraft(reclaimed, { status: 'image_pending', text: '已经保存的文案', imageTaskId: 'existing-image-id', nextCheckAt: due }, afterLease);
  assert.equal(result.leaseToken, null);
  assert.deepEqual(await store.listRunnable(afterLease), []);
  const [waitingImage] = await store.listRunnable(due);
  const imageLease = (await store.reserveDraft(waitingImage, due))!;
  assert.equal(imageLease.status, 'image_pending');
  assert.equal(imageLease.imageTaskId, 'existing-image-id');
  assert.equal(imageLease.text, '已经保存的文案');
});

test('unattended daily execution saves copy before image work and can complete it with the same task', async t => {
  const { sqlite, store } = fixture();
  t.after(() => sqlite.close());
  let clock = start;
  const submissions: string[] = [];
  const file = { name: '素材-1.png', type: 'image/png', url: '/api/marketing-materials/result?taskId=moment-image-1&fileIndex=0' };
  const task = (status: PublicMaterialTask['status'], files: PublicMaterialTask['files'] = []) => ({
    id: 'moment-image-1', requestId: 'fixture', version: 1, status, files, slides: [], progress: 0,
    input: {kind:'image',prompt:'冷萃产品图',target:'',sellingPoints:'',reference:'',size:'1:1',n:1,duration:5,aspectRatio:'16:9'},
    createdAt: start, updatedAt: start, pollAt: 0,
  } satisfies PublicMaterialTask);
  const service = createMomentService(store, {
    availability: async () => ({ text: true, image: true }),
    copy: async (owner, input) => { assert.equal(owner, 'tenant'); assert.equal(input.productName, product.productName); return { text: '午后小歇，来杯冷萃。', imagePrompt: '冷萃产品图' }; },
    submitImage: async (owner, member, requestId, prompt) => {
      assert.equal(member, 'manager'); assert.equal(prompt, '冷萃产品图');
      const saved = await store.getDraft(owner, member, requestId);
      assert.equal(saved.text, '午后小歇，来杯冷萃。');
      submissions.push(requestId);
      return task('queued');
    },
    refreshImage: async (_owner, _member, taskId) => { assert.equal(taskId, 'moment-image-1'); return task('completed', [file]); },
  }, () => clock);
  await service.execute('tenant', 'manager', { action: 'save', plan: product });
  assert.equal((await service.maintenance()).queued, 0);
  clock = due;
  const first = await service.maintenance();
  assert.equal(first.queued, 1); assert.equal(first.statuses.image_pending, 1);
  const [pending] = (await service.snapshot('tenant', 'manager')).drafts;
  assert.equal(pending.text, '午后小歇，来杯冷萃。'); assert.equal(pending.status, 'image_pending');
  assert.ok(!('imageTaskId' in pending));
  clock = '2026-11-10T01:00:00.000Z';
  const next = await service.maintenance();
  assert.equal(next.queued, 0); assert.equal(next.statuses.completed, 1);
  const [finished] = (await service.snapshot('tenant', 'manager')).drafts;
  assert.equal(finished.id, pending.id);
  assert.deepEqual(finished.files, [file]);
  assert.deepEqual(submissions, [pending.id]);
});

test('retired Moments endpoints no longer admit member writes or unattended maintenance', () => {
  const path = 'https://workspace.example/api/moments-materials/maintenance';
  assert.equal(memberRouteAccess(new Request(path, { method: 'POST' })), 'member');
  assert.equal(memberRouteAccess(new Request(path)), 'member');
  assert.equal(memberRouteAccess(new Request(path, { method: 'POST', headers: { 'oai-authenticated-user-id': 'tenant' } })), 'member');
  for (const role of ['sales', 'manager', 'admin'] as const) {
    assert.throws(() => assertMemberApi(role, '/api/moments-materials', 'POST'), { status: 403 });
  }
  assert.throws(() => assertMemberApi('manager', '/api/moments-materials/maintenance', 'POST'), { status: 403 });
});
