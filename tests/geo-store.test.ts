import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createGeoStore } from '../app/lib/geo-store.ts';
import { emptyGeoDocument } from '../app/lib/geo-types.ts';
import type { GeoDocument } from '../app/lib/geo-types.ts';
import { compareGeoMetrics, computeGeoMetrics } from '../app/lib/geo-metrics.ts';
import { diagnoseGeoGaps } from '../app/lib/geo-workflow.ts';
import { assertMemberApi } from '../app/lib/member-policy.ts';

const author = { ownerId: 'tenant', memberId: 'author', role: 'sales' as const };
const manager = { ownerId: 'tenant', memberId: 'manager', role: 'manager' as const };
const otherSales = { ...author, memberId: 'other-sales' };
const otherTenant = { ...manager, ownerId: 'other-tenant' };
const document: GeoDocument = {
  brief: {
    brand: '晨光商圈', topic: '周末活动', audience: '周末访客', question: '周末有哪些活动？',
    sources: [{ title: '活动通知', url: 'https://events.example.org/weekend', excerpt: '周六开放体验。' }],
  },
  article: {
    title: '晨光商圈周末活动', summary: '周六开放体验。',
    markdown: '## 开放体验\n周六开放体验。[1]\n\n## 到场指南\n到场可咨询活动组织者。',
    faq: [{ question: '何时开放？', answer: '周六开放。[1]' }],
  },
};

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: never[] = [];
      return {
        bind(...args: never[]) { values = args; return this; },
        async first() { return statement.get(...values) ?? null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
      };
    },
  } as unknown as D1Database;
  return { sqlite, store: createGeoStore(db) };
}

test('GEO API is available only to authenticated business roles', () => {
  assert.doesNotThrow(() => assertMemberApi('sales', '/api/geo', 'POST'));
  assert.doesNotThrow(() => assertMemberApi('manager', '/api/geo', 'GET'));
  assert.throws(() => assertMemberApi('admin', '/api/geo', 'GET'), { status: 403 });
  assert.throws(() => assertMemberApi('manager', '/api/geo', 'DELETE'), { status: 403 });
});

test('GEO workflow stores actual answers and measures matched before/after samples without changing article review', async t => {
  const {sqlite,store}=fixture();t.after(()=>sqlite.close());
  const plan={questions:[{id:'q1',dimension:'scenario',intent:'decision',prompt:'周末有什么活动？'}],engines:['豆包'],repeats:2,competitors:['示例市集']};
  const baseline={id:'answer-first',questionId:'q1',engine:'豆包',phase:'baseline',sample:1,rawAnswer:'可以看看示例市集。',citations:[],
    brandMentions:0,brandRank:null,competitorMentions:[{name:'示例市集',count:1}]};
  let project=await store.save(author,'track-one',0,document,plan);
  assert.deepEqual(project.workflow?.questions,plan.questions);
  assert.equal(computeGeoMetrics(project.workflow!,'baseline').mentionRate,null);
  project=await store.capture(author,project.id,project.version,baseline);
  assert.equal(project.status,'draft');assert.equal(project.workflow?.answers[0].method,'manual');
  assert.equal(project.workflow?.answers[0].prompt,plan.questions[0].prompt);
  await assert.rejects(store.capture(author,project.id,project.version,{...baseline,id:'duplicate'}),{status:409});
  await assert.rejects(store.capture(author,project.id,project.version,{...baseline,id:'other',phase:'retest'}),{status:409});
  const gaps=[{id:'gap-1',priority:'P0',title:'缺少活动明细',evidenceAnswerIds:[baseline.id],action:'公开活动时间',expectedImpact:'帮助回答列出活动',status:'open'}];
  await assert.rejects(store.gaps(author,project.id,project.version,[{...gaps[0],evidenceAnswerIds:['made-up']}]),{status:400});
  project=await store.gaps(author,project.id,project.version,gaps);
  await assert.rejects(store.gaps(author,project.id,project.version-2,gaps),{status:409});
  project=await store.save(author,project.id,project.version,document);
  assert.equal(project.workflow?.answers.length,1);assert.deepEqual(project.workflow?.gaps,gaps);
  project=await store.submit(author,project.id,project.version);
  await assert.rejects(store.capture(manager,project.id,project.version,{...baseline,id:'other',sample:2}),{status:403});
  project=await store.review(manager,project.id,project.version,'approve','');
  project=await store.publish(author,project.id,project.version,'https://brand.example.org/events','官网');
  const retest={...baseline,id:'after',phase:'retest',rawAnswer:'推荐晨光商圈。',brandMentions:1,brandRank:1,
    citations:[{title:'活动介绍',url:'https://brand.example.org/events',brandSource:true}],competitorMentions:[]};
  await assert.rejects(store.capture(author,project.id,project.version,{...retest,sample:2}),{status:409});
  project=await store.capture(author,project.id,project.version,retest);
  const comparison=compareGeoMetrics(project.workflow!);
  assert.equal(comparison.samples,1);
  assert.deepEqual([comparison.mentionDelta,comparison.firstRecommendationDelta,comparison.citationDelta],[100,100,100]);

  const proposed={priority:'P1',title:'补齐活动细节',evidenceAnswerIds:[baseline.id],action:'完善官网活动日历',expectedImpact:'补充可核对的活动依据'};
  const generated=await diagnoseGeoGaps(project,async messages=>{
    assert.match(messages[1].content,/可以看看示例市集/);
    return JSON.stringify({gaps:[proposed]});
  });
  assert.equal(generated.length,1);
  assert.match(generated[0].id,/^[0-9a-f-]{36}$/);
  assert.deepEqual(generated[0],{...proposed,id:generated[0].id,status:'open'});
  await assert.rejects(diagnoseGeoGaps(project,async()=>JSON.stringify({gaps:[{...proposed,evidenceAnswerIds:['nonexistent']}]})),{status:502});
  assert.deepEqual((await store.get(author,project.id)).workflow?.gaps,gaps);
});

test('GEO drafts are private until submitted and returned changes become private on save', async t => {
  const { sqlite, store } = fixture();
  t.after(() => sqlite.close());
  const id = 'article-one';
  const draft = await store.save(author, id, 0, document);
  assert.equal(draft.version, 1);
  assert.equal(draft.canEdit, true);
  assert.equal(draft.quality.ready, true);
  assert.deepEqual(await store.list(manager), []);
  await assert.rejects(store.get(manager, id), { status: 404 });
  await assert.rejects(store.get(otherTenant, id), { status: 404 });

  const submitted = await store.submit(author, id, draft.version);
  assert.equal(submitted.canEdit, false);
  assert.equal((await store.list(manager))[0].mine, false);
  assert.equal((await store.get(manager, id)).canReview, true);
  assert.deepEqual(await store.list(otherSales), []);
  await assert.rejects(store.review(author, id, submitted.version, 'approve', ''), { status: 403 });
  await assert.rejects(store.review(manager, id, submitted.version, 'changes', ''), { status: 400 });
  await assert.rejects(store.save(author, id, submitted.version, document), { status: 409 });

  const returned = await store.review(manager, id, submitted.version, 'changes', '补充交通信息');
  assert.equal(returned.status, 'changes_requested');
  assert.equal(returned.reviewNote, '补充交通信息');
  assert.equal((await store.get(author, id)).canEdit, true);
  const revised = { ...document, article: { ...document.article, summary: '活动时间与交通信息。' } };
  const edited = await store.save(author, id, returned.version, revised);
  assert.equal(edited.status, 'draft');
  assert.equal(edited.reviewNote, returned.reviewNote);
  assert.deepEqual(await store.list(manager), []);
  await assert.rejects(store.get(manager, id), { status: 404 });
  assert.equal((await store.submit(author, id, edited.version)).status, 'in_review');
  assert.deepEqual((await store.get(manager, id)).document, revised);
});

test('GEO quality gates review; publication and visibility are manual, versioned owner records', async t => {
  const { sqlite, store } = fixture();
  t.after(() => sqlite.close());
  const incomplete = await store.save(author, 'empty-article', 0, emptyGeoDocument());
  assert.equal(incomplete.quality.ready, false);
  await assert.rejects(store.submit(author, incomplete.id, incomplete.version), { status: 400 });

  const id = 'published-article';
  const saved = await store.save(author, id, 0, document);
  const submitted = await store.submit(author, id, saved.version);
  await assert.rejects(store.publish(author, id, submitted.version, 'https://example.org/story', '官网'), { status: 409 });
  const approved = await store.review(manager, id, submitted.version, 'approve', '依据和表述已核对');
  assert.equal(approved.reviewNote, '依据和表述已核对');
  const approval = sqlite.prepare('SELECT reviewer_id,reviewed_at,review_note FROM workbench_geo_projects WHERE owner_id=? AND id=?')
    .get(author.ownerId, id);
  assert.equal(approval?.reviewer_id, manager.memberId);
  assert.equal(approval?.reviewed_at, approved.updatedAt);
  assert.equal(approval?.review_note, approved.reviewNote);
  assert.equal(approved.canRecord, false);
  assert.equal((await store.get(author, id)).canRecord, true);
  await assert.rejects(store.publish(manager, id, approved.version, 'https://example.org/story', '官网'), { status: 403 });
  await assert.rejects(store.publish(author, id, approved.version, 'http://example.org/story', '官网'), { status: 400 });
  await assert.rejects(store.observe(author, id, approved.version, '示例引擎', '周末有哪些活动？', 'unclear', '返回空答复'), { status: 409 });

  const published = await store.publish(author, id, approved.version, 'https://example.org/story', '官网');
  assert.equal(published.status, 'published');
  assert.equal(published.publication?.url, 'https://example.org/story');
  assert.equal(published.publication?.channel, '官网');
  await assert.rejects(store.observe(author, id, published.version, '示例引擎', '周末有哪些活动？', 'mentioned', ''), { status: 400 });
  const observed = await store.observe(author, id, published.version, '示例引擎', '周末有哪些活动？', 'not_mentioned', '人工核对，答案未提及品牌。');
  assert.equal(observed.status, 'published');
  assert.equal(observed.observations.length, 1);
  assert.equal(observed.observations[0].result, 'not_mentioned');
  assert.equal(observed.observations[0].evidence, '人工核对，答案未提及品牌。');
  assert.equal(observed.version, published.version + 1);
  await assert.rejects(store.observe(author, id, published.version, '示例引擎', '周末有哪些活动？', 'not_mentioned', '重复提交'), { status: 409 });
  assert.deepEqual((await store.get(manager, id)).observations, observed.observations);
  assert.equal((await store.get(manager, id)).canRecord, false);
});

test('GEO saves deduplicate exact retries and reject concurrent different content', async t => {
  const { sqlite, store } = fixture();
  t.after(() => sqlite.close());
  const id = 'concurrent-article';
  const saved = await store.save(author, id, 0, document);
  assert.deepEqual(await store.save(author, id, 0, document), saved);
  const first = { ...document, article: { ...document.article, title: '第一个标题' } };
  const second = { ...document, article: { ...document.article, title: '第二个标题' } };
  const writes = await Promise.allSettled([store.save(author, id, saved.version, first), store.save(author, id, saved.version, second)]);
  assert.equal(writes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(writes.find(item => item.status === 'rejected')?.reason.status, 409);
  assert.equal((await store.get(author, id)).version, 2);
  assert.equal((await store.list(author))[0].mine, true);
});
