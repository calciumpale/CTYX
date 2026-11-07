import test from 'node:test';
import assert from 'node:assert/strict';
import { researchCompany, JINGHAI_ENDPOINT } from '../app/lib/company-research.ts';
import type { Deal } from '../app/lib/types.ts';
import { createSeed } from '../app/lib/seed.ts';
import { executeMemberAction } from '../app/lib/member-policy.ts';

const name = '示远科技（上海）有限公司';
const deal = { name, website: '', contact: 'PRIVATE_CONTACT', summary: 'PRIVATE_NEEDS', amount: 778899 } as unknown as Deal;
const jinghai = { appId: 'fixture-app-id', apiKey: 'fixture-api-key', endpoint: 'https://www.kqdaas.com/DataService/api/v3/company/detail' };
const qcc = { appKey: 'fixture-qcc-app', secretKey: 'fixture-qcc-secret', endpoint: 'https://api.qichacha.com/ECIV4/GetBasicDetailsByName' };
const now = '2026-11-07T02:00:00.000Z';
const registry = { status: 200, success: true, data: {
  companyName: name, juridicalPerson: '测试法人', businessStatus: '存续',
  creditNumber:'fixture-credit',regitAddress:'示例注册地址',registeredCapital:'100万元',
  staffNumber:'0~49',socialSecurityNum:0,historyNames:['曾用名有限公司'],
} };
const rss = '<rss><channel><item><title>公司资料</title><link>https://example.com/company</link><description>公开来源里的公司资料。</description></item></channel></rss>';

test('Jinghai uses the documented exact-name path and header credentials, keeping private customer facts local', async () => {
  const requests: string[] = [];
  const result = await researchCompany(deal, { qcc, jinghai, model: null, now, request: async (input, init) => {
    const url = new URL(String(input)); requests.push(url.href);
    assert.equal(url.origin + url.pathname, JINGHAI_ENDPOINT + '/' + encodeURIComponent(name.replace('（','(').replace('）',')')));
    assert.equal(url.searchParams.get('queryType'), '1');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-Jinghai-App-Id'), jinghai.appId);
    assert.equal(headers.get('X-Jinghai-Api-Key'), jinghai.apiKey);
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.method, 'GET');
    for (const value of [jinghai.appId, jinghai.apiKey, 'PRIVATE_CONTACT', 'PRIVATE_NEEDS', '778899']) assert.ok(!url.href.includes(value));
    return Response.json(registry);
  } });
  assert.equal(requests.length, 1);
  assert.equal(result.provider, 'jinghai');
  assert.equal(result.companyName, name);
  assert.equal(result.facts.find(fact => fact.label === '法定代表人')?.value, '测试法人');
  assert.equal(result.facts.find(fact => fact.label === '经营状态')?.value, '存续');
  assert.equal(result.facts.find(fact => fact.label === '统一社会信用代码')?.value,'fixture-credit');
  assert.equal(result.facts.find(fact => fact.label === '注册地址')?.value,'示例注册地址');
  assert.equal(result.facts.find(fact => fact.label === '参保人数')?.value,'0');
  assert.equal(result.facts.find(fact => fact.label === '人员规模（数据源区间）')?.value,'0~49');
  assert.ok(result.sources.every(source => source.provider === 'jinghai'));
  assert.ok(result.facts.every(fact => fact.sourceIds.every(id => result.sources.some(source => source.id === id))));
  assert.ok(!JSON.stringify(result).includes(jinghai.apiKey));
});

test('documented errcode wrapper and normalized half-width company parentheses are accepted',async()=>{
  const result=await researchCompany(deal,{qcc:null,jinghai,model:null,now,request:async()=>Response.json({
    errcode:200,errmsg:'Success',data:{...registry.data,companyName:name.replace('（','(').replace('）',')')},
  })});
  assert.equal(result.provider,'jinghai');
  assert.ok(result.facts.some(fact=>fact.label==='法定代表人'));
});

test('Jinghai failure tries configured QCC before public search without returning provider errors', async () => {
  const urls: string[] = [];
  const result = await researchCompany(deal, { qcc, jinghai, model: null, now, request: async (input) => {
    urls.push(String(input));
    if (urls.length === 1) return Response.json({ status: 403, success: false, message: jinghai.apiKey });
    return Response.json({ Status: '200', Result: { Name: name, Status: '存续' } });
  } });
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]).hostname, 'api.qichacha.com');
  assert.equal(result.provider, 'qcc');
  assert.match(result.warnings.join(' '), /鲸海/);
  assert.ok(!JSON.stringify(result).includes(jinghai.apiKey));
});

test('contradictory success flags, missing identities, and different-company records cannot become company facts', async () => {
  for (const response of [
    { ...registry, success: false },
    { ...registry, status: 403 },
    { ...registry, data: { companyName: '另一家有限公司' } },
    { ...registry, data: { businessStatus: '存续' } },
    { ...registry, data: [registry.data, { companyName: '另一家公司' }] },
  ]) {
    let calls = 0;
    const result = await researchCompany(deal, { qcc: null, jinghai, model: null, now, request: async () =>
      ++calls === 1 ? Response.json(response) : new Response(rss),
    });
    assert.equal(result.provider, 'web');
    assert.equal(result.companyName, name);
    assert.deepEqual(result.facts, []);
  }
});

test('Jinghai URLs are fixed and redirects never forward authentication', async () => {
  for (const endpoint of ['https://www.kqdaas.com.evil.example/DataService/api/v3/company/detail', 'http://127.0.0.1', 'https://other.example']) {
    let calls = 0;
    const result = await researchCompany(deal, { qcc: null, jinghai: { ...jinghai, endpoint }, model: null, now, request: async (input, init) => {
      calls++;
      assert.equal(new URL(String(input)).hostname, 'www.bing.com');
      assert.equal(new Headers(init?.headers).has('X-Jinghai-Api-Key'), false);
      return new Response(rss);
    } });
    assert.equal(result.provider, 'web'); assert.equal(calls, 1);
  }
  let calls = 0;
  const result = await researchCompany(deal, { qcc: null, jinghai, model: null, now, request: async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    return calls === 1 ? new Response('', { status: 302, headers: { Location: 'https://other.example/collect' } }) : new Response(rss);
  } });
  assert.equal(calls, 2); assert.equal(result.provider, 'web');
});

test('the normal customer enrichment action persists Jinghai facts, citations, and execution provenance',async()=>{
  const state=createSeed();
  const customer=state.deals[0];
  const result=await executeMemberAction(state,'manager','deal_enrich',{dealId:customer.id,version:customer.version},{
    enrichCompany:async current=>researchCompany(current,{
      qcc:null,jinghai,model:null,now,
      request:async()=>Response.json({...registry,data:{...registry.data,companyName:current.name}}),
    }),
  });
  const saved=result.state.deals.find(item=>item.id===customer.id)!;
  assert.equal(saved.companyProfile?.provider,'jinghai');
  assert.ok(saved.companyProfile?.facts.some(item=>item.label==='统一社会信用代码'));
  assert.ok(result.run?.steps.some(item=>item.detail.includes('鲸海数据接口')));
  assert.ok(result.run?.citations.some(item=>item.excerpt.includes('来源：鲸海数据')));
});
