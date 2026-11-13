import assert from 'node:assert/strict';
import test from 'node:test';
import { searchJinghaiCompanyPenalties } from '../app/lib/jinghai-record-research.ts';

const company = { name: '示远科技（上海）有限公司' };
const credentials = {
  appId: 'test-app',
  apiKey: 'test-key',
  endpoint: 'https://www.kqdaas.com/DataService/api/v3/company/detail',
};
const reply = (data: unknown) => Response.json({ errcode: 200, success: true, data });
const own = {
  companyName: '示远科技(上海)有限公司',
  行政处罚决定书文号: '示市监处罚〔2025〕123号',
  处罚决定日期: '2025-06-10',
  公示日期: '2025-06-18',
  处罚机关: '示例市场监督管理局',
  行政处罚内容: '处以罚款人民币5000元。',
};

test('queries the documented fixed penalty endpoint and keeps the actual subject and decision in each record', async () => {
  let calls = 0;
  const result = await searchJinghaiCompanyPenalties(company, credentials, async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.kqdaas.com');
    assert.equal(decodeURIComponent(url.pathname), '/DataService/api/v3/company/punishment/示远科技(上海)有限公司');
    assert.deepEqual(Object.fromEntries(url.searchParams), { queryType: '1', pageIndex: '1', pageSize: '10' });
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-Jinghai-App-Id'), credentials.appId);
    assert.equal(headers.get('X-Jinghai-Api-Key'), credentials.apiKey);
    assert.equal(init?.body, undefined);
    return reply({ records: [own, { ...own, companyName: '示远科技(上海)有限公司浦东店' }] });
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'records');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].subject, own.companyName);
  assert.equal(result.records[0].decisionNo, own.行政处罚决定书文号);
  assert.equal(result.records[0].decisionDate, own.处罚决定日期);
  assert.equal(result.records[0].publicationDate, own.公示日期);
  assert.match(result.records[0].excerpt, /处以罚款人民币5000元/);
  assert.equal(result.records[0].kind, 'administrative-penalty');
  assert.equal(result.source.provider, 'jinghai');
});

test('supports an exact credit code without attributing another subject or preliminary notice', async () => {
  const creditCode = '913401007548775701';
  const result = await searchJinghaiCompanyPenalties({ ...company, creditCode }, credentials, async input => {
    assert.match(String(input), /\/punishment\/913401007548775701\?queryType=2&/);
    return reply({ records: [
      { ...own, creditNumber: '91341523695736902C' },
      { ...own, companyName: '另一家公司', creditNumber: creditCode },
      { ...own, creditNumber: creditCode + 'X' },
      { ...own, 行政处罚内容: '拟处以罚款人民币5000元。' },
      { ...own, 行政处罚内容: '不予行政处罚。' },
      { ...own, 行政处罚内容: '供应商被市监局处以罚款人民币5000元。' },
      { ...own, 行政处罚内容: '公司在2025年公告其供应商被处以罚款。' },
      { ...own, companyName: undefined, creditNumber: creditCode },
      { ...own, 行政处罚内容: '处以罚款人民币5000元。' + '相关说明'.repeat(400) + '本行政处罚已撤销。' },
    ] });
  });
  assert.equal(result.status, 'unverified');
  assert.deepEqual(result.records, []);
});

test('keeps explicit empty pages, ambiguous or unsupported payloads, and outages distinct', async () => {
  for (const [response, status] of [
    [reply({ records: [], totalRecords: 0 }), 'empty'],
    [reply({ records: [], totalRecords: 10 }), 'unverified'],
    [reply({}), 'unverified'],
    [reply({ records: [{ anything: 'unrecognized' }] }), 'unverified'],
    [Response.json({ errcode: 404, success: false }), 'unverified'],
    [new Response('', { status: 404 }), 'unverified'],
    [new Response('', { status: 403 }), 'unavailable'],
    [new Response('', { status: 302, headers: { Location: 'https://other.example' } }), 'unavailable'],
    [Response.json({ errcode: 403, success: true, data: { records: [own] } }), 'unavailable'],
  ] as const) {
    const result = await searchJinghaiCompanyPenalties(company, credentials, async () => response);
    assert.equal(result.status, status);
    assert.deepEqual(result.records, []);
  }
  const result = await searchJinghaiCompanyPenalties(company, credentials, async () => {
    throw new Error(credentials.apiKey);
  });
  assert.equal(result.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /test-key/);
});

test('refuses project input that could change the documented provider path', async () => {
  for (const name of ['.', '..', '../企业名', '企业\\分店']) {
    let called = false;
    const result = await searchJinghaiCompanyPenalties({ name }, credentials, async () => {
      called = true;
      return reply({});
    });
    assert.equal(called, false);
    assert.equal(result.status, 'unavailable');
  }
});
