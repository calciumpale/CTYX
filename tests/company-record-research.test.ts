import assert from 'node:assert/strict';
import test from 'node:test';
import { companyRecordEvidencePassage, isCompanyPenaltyLookup, searchCompanyRecords } from '../app/lib/company-record-research.ts';

const name = '示远餐饮有限公司';
const query = '帮我搜一下这家企业有没有违规记录';
const passage = (text: string, title = '', question = query) => companyRecordEvidencePassage(name, question, title, text);
const rss = (items: { title: string; url: string; excerpt: string; publishedAt?: string }[]) =>
  '<rss><channel>' + items.map(({ title, url, excerpt, publishedAt }) =>
    `<item><title><![CDATA[${title}]]></title><link><![CDATA[${url}]]></link><description><![CDATA[${excerpt}]]></description>${publishedAt ? `<pubDate>${publishedAt}</pubDate>` : ''}</item>`).join('') + '</channel></rss>';

test('identifies a regulator action against the exact company and returns the original evidence sentence', () => {
  const action = '2025年6月3日，海川市市场监管局对示远餐饮有限公司作出行政处罚，罚款3000元。';
  assert.deepEqual(passage('企业简介。' + action + '另有其他资讯。'), {
    excerpt: action, scope: 'company', kind: 'administrative-penalty',
  });
  const named = '行政相对人：示远餐饮有限公司。市场监督管理局决定对当事人罚款三千元。';
  assert.deepEqual(passage(named), { excerpt: named, scope: 'company', kind: 'administrative-penalty' });
  const field = '被处罚单位：示远餐饮有限公司；处罚结果：警告，并处五千元罚款。';
  assert.deepEqual(passage(field), { excerpt: field, scope: 'company', kind: 'administrative-penalty' });
});

test('distinguishes branches, explicitly affiliated stores, and listing disclosure from company-level action', () => {
  const branch = '示远餐饮有限公司东城路店因使用不符合卫生标准的餐具，被海川市市场监管局罚款1000元。';
  assert.equal(passage(branch)?.scope, 'related');
  const stores = '示远餐饮有限公司旗下13家直营店发生食品安全事件，受到13项行政处罚。';
  assert.equal(passage(stores)?.scope, 'related');
  assert.equal(passage('示远餐饮有限公司旗下13家直营店因食品安全事件受行政处罚。')?.scope, 'related');
  const report = '我們的13家直營店發生食品安全事故，並導致13項行政處罰。';
  assert.deepEqual(passage(report, '示遠餐飲有限公司招股說明書（申報稿）'), {
    excerpt: report, scope: 'related', kind: 'administrative-penalty',
  });
  assert.equal(passage(report, '示遠餐飲有限公司港股申請版本')?.scope, 'related');
  assert.deepEqual(passage('示遠餐飲有限公司是本集團境內運營主體。' + report, '示远国际控股有限公司港股申請版本'), {
    excerpt: '示遠餐飲有限公司是本集團境內運營主體。' + report, scope: 'related', kind: 'administrative-penalty',
  });
  assert.equal(passage(report, '行业头条：老乡鸡招股说明书'), undefined);
});

test('rejects similar names, other parties in the same sentence, general news and unconfirmed allegations', () => {
  for (const [text, title] of [
    ['新示远餐饮有限公司被市场监管局行政处罚。', ''],
    ['示远餐饮有限公司集团被市场监管局罚款3000元。', ''],
    ['新闻：示远餐饮有限公司与邻里餐饮有限公司合作，后者被监管部门行政处罚。', ''],
    ['示远餐饮有限公司发现邻里餐饮有限公司被市场监管局行政处罚。', ''],
    ['市场监管局处罚邻里餐饮有限公司，示远餐饮有限公司接受采访。', ''],
    ['示远餐饮有限公司公布食品安全管理办法，违者可能受到行政处罚。', ''],
    ['用户投诉示远餐饮有限公司，认为该公司应被处罚。', ''],
    ['行政处罚查询：示远餐饮有限公司。', ''],
    ['网友称示远餐饮有限公司受到行政处罚，尚待监管部门核实。', ''],
    ['市场监管局处罚了多家商户。', '示远餐饮有限公司工商信息'],
    ['某门店被市场监管局处罚。', '示远餐饮有限公司相关资讯'],
    ['示远餐饮有限公司拟被处以罚款3000元。', ''],
    ['示远餐饮有限公司因供应商曾被罚款而取消合作。', ''],
    ['示远餐饮有限公司在2022年公布其他餐厅被处以行政处罚。', ''],
    ['示远餐饮有限公司于2025年6月宣布，其经销商被罚款5000元。', ''],
    ['示远餐饮有限公司的法定代表人被市场监督管理局罚款5000元。', ''],
    ['海川市市场监管局拟对示远餐饮有限公司罚款3000元。', ''],
    ['示远餐饮有限公司受到行政处罚，随后该行政处罚被撤销。', ''],
    ['示远餐饮有限公司受到行政处罚。随后，该处罚决定被撤销。', ''],
  ]) assert.equal(passage(text, title), undefined, text);
});

test('does not use no-penalty decisions, no-record statements or unanswered questions as affirmative records', () => {
  for (const text of [
    '示远餐饮有限公司东城路店违法行为轻微，市场监督管理局决定不予行政处罚。',
    '市场监管局发布示远餐饮有限公司不予行政处罚决定书。',
    '未发现示远餐饮有限公司受到行政处罚。',
    '示远餐饮有限公司没有被列入经营异常名录。',
    '示远餐饮有限公司是否曾被罚款？',
    '示远餐饮有限公司收到不予行政处罚决定书。市场监管局决定对当事人不予罚款。',
  ]) assert.equal(passage(text, '示远餐饮有限公司行政处罚信息'), undefined, text);
});

test('does not mistake common enforcement or food sampling for a different class of record', () => {
  const enforcement = '示远餐饮有限公司被海川市人民法院列为被执行人，执行案号为（2025）示01执123号。';
  assert.equal(passage(enforcement, '', '这家客户有被执行记录吗')?.kind, 'judicial-enforcement');
  assert.equal(passage(enforcement, '', '这家客户是不是失信被执行人'), undefined);
  const abnormal = '示远餐饮有限公司因未按时公示年报，被海川市市场监督管理局列入经营异常名录。';
  assert.equal(passage(abnormal, '', '有经营异常吗')?.kind, 'business-abnormality');
  assert.equal(passage(abnormal, '', '有没有行政处罚'), undefined);
  const sampling = '海川市市场监督管理局通报示远餐饮有限公司东城店经营的餐具监督抽检不合格。';
  assert.equal(passage(sampling, '', '查食品安全风险')?.kind, 'food-safety');
  assert.equal(passage(sampling, '', '这家客户受过行政处罚吗'), undefined);
  assert.equal(passage(abnormal, '', '这家客户被罚过吗'), undefined);
  assert.equal(passage('示远餐饮有限公司被市场监管局罚过3000元。', '', '这家客户被罚过吗')?.kind, 'administrative-penalty');
});

test('routes broad record requests and penalties to a penalty lookup without extending narrow queries', () => {
  assert.equal(isCompanyPenaltyLookup(query), true);
  assert.equal(isCompanyPenaltyLookup('这家客户被罚过吗'), true);
  assert.equal(isCompanyPenaltyLookup('查行政处罚和经营异常'), true);
  assert.equal(isCompanyPenaltyLookup('有没有被执行或经营异常'), false);
  assert.equal(isCompanyPenaltyLookup('查食品安全风险'), false);
});

test('outbound search contains only the exact authorized name and fixed record terms', async () => {
  const seen: string[] = [];
  const results = await searchCompanyRecords({
    name, ...{ contact: 'CRM-SECRET', notes: ['PRIVATE-NOTE'], website: 'https://private.example.com' },
  }, '客户有没有违规记录？私密聊天 PRIVATE-QUERY', {
    request: async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://www.bing.com');
      assert.equal(options?.method ?? 'GET', 'GET');
      assert.equal(options?.redirect, 'manual');
      seen.push(url.searchParams.get('q')!);
      return new Response(rss([
        { url: 'https://notice.example.com/decision?utm_medium=rss#details', title: '海川市市监局行政处罚决定',
          excerpt: '海川市市场监管局对示远餐饮有限公司作出行政处罚，罚款3000元。', publishedAt: 'Fri, 05 Jun 2026 00:00:00 GMT' },
        { url: 'http://127.0.0.1/private', title: '行政处罚决定', excerpt: '示远餐饮有限公司因使用过期食材被罚款3000元。' },
        { url: 'https://notice.internal/private', title: '行政处罚决定', excerpt: '示远餐饮有限公司因使用过期食材被罚款3000元。' },
      ]));
    },
  });
  assert.ok(seen.length >= 1 && seen.length <= 3);
  assert.ok(seen.every(text => text.includes(`"${name}"`) && !/CRM-SECRET|PRIVATE-NOTE|PRIVATE-QUERY|private\.example/.test(text)));
  assert.equal(results.status, 'completed');
  assert.equal(results.sources.length, 1);
  assert.equal(results.sources[0].url, 'https://notice.example.com/decision');
  assert.equal(results.sources[0].publishedAt, '2026-06-05T00:00:00.000Z');
  assert.match(results.sources[0].retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(results.sources[0].id, /^record-web-/);
  assert.equal(results.sources[0].excerpt, '海川市市场监管局对示远餐饮有限公司作出行政处罚，罚款3000元。');
});

test('distinguishes a completed empty search from failed or partially unavailable transport', async () => {
  assert.deepEqual(await searchCompanyRecords({ name }, query, { request: async () => new Response(rss([])) }), { status: 'completed', sources: [], provider: 'bing' });
  assert.deepEqual(await searchCompanyRecords({ name }, query, { request: async () => new Response('provider secret', { status: 500 }) }), { status: 'failed', sources: [], provider: 'bing' });
  let n = 0;
  assert.deepEqual(await searchCompanyRecords({ name }, query, { request: async () => ++n === 1 ? new Response(rss([])) : new Response('<rss>') }), { status: 'partial', sources: [], provider: 'bing' });
  let contacted = false;
  for (const name of ['示远" OR 公网', '示远＂广告有限公司']) {
    assert.deepEqual(await searchCompanyRecords({ name }, query, { request: async () => {
      contacted = true;
      return new Response(rss([]));
    } }), { status: 'failed', sources: [] });
  }
  assert.equal(contacted, false);
});

const officialModel = { url: 'https://api.deepseek.com/v1/chat/completions', key: 'TEST-PROVIDER-KEY' };

test('uses the documented same-origin DeepSeek Search API with only authorized identity and a fixed topic', async () => {
  const calls: string[] = [];
  const result = await searchCompanyRecords({ name }, '这家客户有行政处罚吗 PRIVATE-QUESTION', {
    model: officialModel,
    request: async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer TEST-PROVIDER-KEY');
      assert.deepEqual(JSON.parse(String(init?.body)), { query: `"${name}" 行政处罚`, count: 8, need_content: false });
      return Response.json({ results: [
        { title: '海川市市场监管局行政处罚决定', url: 'https://notice.example.com/decision?utm_source=search', snippet: '示远餐饮有限公司被市场监管局罚款3000元。', date: '2025-06-03T02:00:00Z' },
        { title: '重复来源', url: 'https://notice.example.com/decision', snippet: '示远餐饮有限公司被市场监管局罚款3000元。' },
        { title: '不相关链接', url: 'https://www.so.com/link?m=encrypted', snippet: '示远餐饮有限公司被市场监管局罚款3000元。' },
      ] });
    },
  });
  assert.deepEqual(calls, ['https://api.deepseek.com/v1/tools/search']);
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.sources.map(({ url, excerpt, publishedAt }) => ({ url, excerpt, publishedAt })), [{
    url: 'https://notice.example.com/decision',
    excerpt: '示远餐饮有限公司被市场监管局罚款3000元。',
    publishedAt: '2025-06-03T02:00:00.000Z',
  }]);
});

test('queries each explicitly requested topic and keeps the broad search to one DeepSeek request', async () => {
  for (const [question, expected, status] of [
    ['查行政处罚和经营异常', ['行政处罚', '经营异常名录'], 'completed'],
    ['有没有违规记录', ['行政处罚'], 'partial'],
  ] as const) {
    const topics: string[] = [];
    const result = await searchCompanyRecords({ name }, question, {
      model: officialModel,
      request: async (_input, init) => {
        const topic = JSON.parse(String(init?.body)).query.slice(name.length + 3);
        topics.push(topic);
        const abnormal = topic === '经营异常名录';
        return Response.json({ results: [{
          title: topic, url: `https://notice.example.com/${abnormal ? 'abnormal' : 'penalty'}`,
          snippet: abnormal ? '示远餐饮有限公司被列入经营异常名录。' : '示远餐饮有限公司被市场监管局罚款3000元。',
        }] });
      },
    });
    assert.deepEqual(topics, expected);
    assert.equal(result.status, status);
    assert.equal(result.sources.length, expected.length);
  }
});

test('preserves usable public results and reports partial when an explicit DeepSeek topic fails', async () => {
  const result = await searchCompanyRecords({ name }, '查行政处罚和经营异常', {
    model: officialModel,
    request: async (_input, init) => String(init?.body).includes('经营异常名录')
      ? new Response('', { status: 503 })
      : Response.json({ results: [{
        title: '处罚公示', url: 'https://notice.example.com/penalty', snippet: '示远餐饮有限公司被市场监管局罚款3000元。',
      }] }),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.sources[0]?.kind, 'administrative-penalty');
});

test('falls back to public RSS after the official provider is unavailable or has no matching evidence', async () => {
  for (const [upstream, reason] of [
    [() => Response.json({ results: [] }), 'empty'],
    [() => Response.json({ unexpected: [] }), 'failed'],
    [() => new Response('', { status: 302, headers: { Location: 'https://secret-redirect.example.com' } }), 'failed'],
    [() => new Response('provider error with TEST-PROVIDER-KEY', { status: 402 }), 'failed'],
  ] as const) {
    const calls: string[] = [];
    const result = await searchCompanyRecords({ name }, '行政处罚', {
      model: officialModel,
      request: async (input, init) => {
        const host = new URL(String(input)).hostname;
        calls.push(host);
        if (host === 'api.deepseek.com') return upstream();
        assert.equal(host, 'www.bing.com');
        assert.equal(new Headers(init?.headers).get('authorization'), null);
        return new Response(rss([{ url: 'https://notice.example.com/result', title: '结果', excerpt: '示远餐饮有限公司被市场监管局罚款3000元。' }]));
      },
    });
    assert.deepEqual(calls, ['api.deepseek.com', 'www.bing.com']);
    assert.equal(result.provider, 'bing');
    assert.equal(result.deepseekStatus, reason);
    assert.equal(result.sources.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /TEST-PROVIDER-KEY|secret-redirect/);
  }
});

test('falls back if DeepSeek stalls while reading an otherwise successful response body', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  let cancelled = false;
  const result = searchCompanyRecords({ name }, '行政处罚', {
    model: officialModel,
    request: async (input, init) => {
      if (new URL(String(input)).hostname !== 'api.deepseek.com') return new Response(rss([]));
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return new Response(new ReadableStream<Uint8Array>({
        start() {},
        cancel() { cancelled = true; },
      }));
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  context.mock.timers.tick(8001);
  assert.deepEqual(await result, { status: 'completed', provider: 'bing', deepseekStatus: 'failed', sources: [] });
  assert.equal(aborted, true);
  assert.equal(cancelled, true);
});

test('does not use a gateway model name or untrusted URL as authorization to send its key', async () => {
  for (const url of [
    'https://api.deepseek.com.example.org/v1/chat/completions',
    'http://api.deepseek.com/v1/chat/completions',
    'https://api.deepseek.com:8443/v1/chat/completions',
    'https://user:password@api.deepseek.com/v1/chat/completions',
  ]) {
    const hosts: string[] = [];
    await searchCompanyRecords({ name }, '行政处罚', {
      model: { key: officialModel.key, url, ...{ name: 'deepseek-flash' } },
      request: async (input, init) => {
        hosts.push(new URL(String(input)).hostname);
        assert.equal(new Headers(init?.headers).get('authorization'), null);
        return new Response(rss([]));
      },
    });
    assert.deepEqual(hosts, ['www.bing.com']);
  }
});
