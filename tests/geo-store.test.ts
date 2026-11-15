import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createGeoStore } from '../app/lib/geo-store.ts';
import { emptyGeoDocument } from '../app/lib/geo-types.ts';
import type { GeoCaptureProviderOptions, GeoDocument } from '../app/lib/geo-types.ts';
import { compareGeoMetrics, computeGeoMetrics } from '../app/lib/geo-metrics.ts';
import { diagnoseGeoGaps, selectGeoGapGuidance } from '../app/lib/geo-workflow.ts';
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
  assert.deepEqual(selectGeoGapGuidance(project,['gap-1']),[{title:gaps[0].title,action:gaps[0].action}]);
  assert.throws(()=>selectGeoGapGuidance(project,['unavailable']),{status:400});
});

test('API Mart captures use the exact prompt, retry idempotently, and retest against the same verified model and mode', async t => {
  const {sqlite,store}=fixture();t.after(()=>sqlite.close());
  const question={id:'q1',dimension:'scenario',intent:'decision',prompt:'周末带小孩到哪里？'};
  const slot={questionId:'q1',engine:'ChatGPT',phase:'baseline',sample:1};
  const plan={questions:[question],engines:[slot.engine],repeats:2,competitors:['示例市集']};
  const calls: Array<{engine:string;prompt:string;options?:{model?:string;webSearch?:boolean}}> = [];
  const result={rawAnswer:'## 推荐榜单\n1. **晨光商圈**：周六公开活动。\n2. 示例市集：周日开放。',
    citations:[{title:'公告',url:'https://events.example.org/weekend#time'},{title:'非公开',url:'https://127.0.0.1/private'}],
    model:'gpt-test',requestId:'provider-request-1',webSearch:true};
  const provider={engines:['ChatGPT'],capture:async(engine:string,prompt:string,options?:{model?:string;webSearch?:boolean})=>{
    calls.push({engine,prompt,options});return result;
  }};
  let project=await store.save(author,'paid-capture',0,document,plan);
  const originalVersion=project.version;
  const saved=await store.captureAI(author,project.id,originalVersion,slot,'capture-one',async()=>provider);
  assert.equal(saved.capture.status,'saved');assert.equal(saved.project.version,originalVersion+2);
  const answer=saved.project.workflow!.answers[0];
  assert.deepEqual(calls,[{engine:slot.engine,prompt:question.prompt,options:undefined}]);
  assert.equal(answer.rawAnswer,result.rawAnswer);assert.equal(answer.brandMentions,1);assert.equal(answer.brandRank,1);
  assert.deepEqual(answer.citations,[{...result.citations[0],brandSource:true}]);
  assert.deepEqual(answer.provenance,{provider:'apimart',model:'gpt-test',requestId:'provider-request-1',webSearch:true,annotations:'provider',captureId:'capture-one'});
  assert.equal((await store.captureAI(author,project.id,originalVersion,slot,'capture-one',async()=>assert.fail('replay must not use APIMart'))).capture.status,'saved');
  await assert.rejects(store.captureAI(author,project.id,saved.project.version,slot,'capture-duplicate',async()=>provider),{status:409});
  assert.equal(calls.length,1);
  project=await store.submit(author,project.id,saved.project.version);
  project=await store.review(manager,project.id,project.version,'approve','');
  project=await store.publish(author,project.id,project.version,'https://events.example.org/weekend','官网');
  const retest={...slot,phase:'retest'};
  await assert.rejects(store.capture(author,project.id,project.version,{...retest,id:'manual-retest',rawAnswer:'人工',citations:[],brandMentions:0,brandRank:null,competitorMentions:[]}),{status:409});
  const checked=await store.captureAI(author,project.id,project.version,retest,'retest-one',async()=>provider);
  assert.deepEqual(calls[1].options,{provider:'apimart',model:'gpt-test',webSearch:true});
  assert.equal(compareGeoMetrics(checked.project.workflow!).samples,1);
});

test('workspace model captures record their own provider and reject a different provider on retest',async t=>{
  const {sqlite,store}=fixture();t.after(()=>sqlite.close());
  const plan={questions:[{id:'q1',dimension:'category',intent:'awareness',prompt:'周末去哪家商圈？'}],engines:['DeepSeek'],repeats:1,competitors:[]};
  const slot={questionId:'q1',engine:'DeepSeek',phase:'baseline',sample:1};
  const providerCalls: GeoCaptureProviderOptions[]=[];
  const result={provider:'workspace' as const,rawAnswer:'晨光商圈可以看看。',citations:[],model:'deepseek-chat',webSearch:false};
  const connection={engines:['DeepSeek'],supports:()=>true,capture:async(_engine:string,_prompt:string,options?:GeoCaptureProviderOptions)=>{
    if(options)providerCalls.push(options);return result;
  }};
  let project=await store.save(author,'workspace-model',0,document,plan);
  const captured=await store.captureAI(author,project.id,project.version,slot,'workspace-baseline',async()=>connection);
  const baseline=captured.project.workflow!.answers[0];
  assert.equal(baseline.method,'workspace');
  assert.deepEqual(baseline.provenance,{provider:'workspace',model:'deepseek-chat',webSearch:false,annotations:'none',captureId:'workspace-baseline'});
  assert.equal(computeGeoMetrics(captured.project.workflow!,'baseline').citationRate,null);
  project=await store.submit(author,project.id,captured.project.version);
  project=await store.review(manager,project.id,project.version,'approve','');
  project=await store.publish(author,project.id,project.version,'https://events.example.org/weekend','官网');
  const retest={...slot,phase:'retest'};
  await assert.rejects(store.captureAI(author,project.id,project.version,retest,'unsupported-fallback',async()=>({
    ...connection,supports:(_engine:string,options?:GeoCaptureProviderOptions)=>options?.provider==='apimart',
    capture:async()=>assert.fail('Must not substitute APIMart before charging'),
  })),{status:503});
  const mismatched=await store.captureAI(author,project.id,project.version,retest,'wrong-provider',async()=>({
    ...connection,capture:async()=>({...result,provider:'apimart' as const}),
  }));
  assert.equal(mismatched.capture.status,'unknown');
  assert.equal(mismatched.project.workflow?.answers.length,1);
  const completed=await store.captureAI(author,project.id,mismatched.project.version,retest,'same-provider',async()=>connection);
  assert.deepEqual(providerCalls,[{provider:'workspace',model:'deepseek-chat',webSearch:false}]);
  assert.equal(compareGeoMetrics(completed.project.workflow!).samples,1);
  assert.equal(compareGeoMetrics(completed.project.workflow!).citationDelta,null);
});

test('simultaneous and ambiguous paid captures hold the persisted claim and never fabricate measurements',async t=>{
  const {sqlite,store}=fixture();t.after(()=>sqlite.close());
  const plan={questions:[{id:'q1',dimension:'category',intent:'awareness',prompt:'有哪些品牌？'}],engines:['Gemini'],repeats:1,competitors:[]};
  const slot={questionId:'q1',engine:'Gemini',phase:'baseline',sample:1};
  const project=await store.save(author,'abandoned-capture',0,document,plan);
  let entered: ()=>void;
  let release: ()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const wait=new Promise<void>(resolve=>{release=resolve;});
  let calls=0;
  const provider={engines:['Gemini'],capture:async()=>{calls++;entered();await wait;throw new Error('temporary transport detail');}};
  const pending=store.captureAI(author,project.id,project.version,slot,'first-attempt',async()=>provider);
  await started;
  const running=await store.captureAI(author,project.id,project.version,slot,'first-attempt',async()=>provider);
  assert.equal(running.capture.status,'running');
  await assert.rejects(store.captureAI(author,project.id,running.project.version,slot,'second-attempt',async()=>provider),{status:409});
  release!();
  const failed=await pending;
  assert.equal(failed.capture.status,'unknown');
  assert.equal(failed.project.workflow!.answers.length,0);assert.equal(computeGeoMetrics(failed.project.workflow!,'baseline').mentionRate,null);
  assert.equal((await store.captureAI(author,project.id,project.version,slot,'first-attempt',async()=>provider)).capture.status,'unknown');
  assert.equal(calls,1);
  const retry=await store.captureAI(author,project.id,failed.project.version,slot,'retry-confirmed',async()=>({engines:['Gemini'],capture:async()=>({
    rawAnswer:'晨光商圈可供参考。',citations:[],model:'gemini-test',webSearch:false,
  })}));
  const metrics=computeGeoMetrics(retry.project.workflow!,'baseline');
  assert.equal(metrics.mentionRate,100);assert.equal(metrics.firstRecommendationRate,null);assert.equal(metrics.citationRate,null);
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
