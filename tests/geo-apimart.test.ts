import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptConnectionSecret } from '../app/lib/connection-config.ts';
import { readGeoAIConnection } from '../app/lib/geo-apimart.ts';

const owner = 'workbench-owner';
const key = 'synthetic-provider-key';
const encryption = 'ab'.repeat(32);

async function environment(enabled = true) {
  const secret = await encryptConnectionSecret(key, encryption, owner, 'apimart');
  const DB = {
    prepare(sql: string) {
      assert.match(sql, /kind='apimart'/);
      return {
        bind(ownerId: string) {
          return {
            first: async () => ownerId === owner ? {
              enabled: enabled ? 1 : 0, secret_ciphertext: secret, version: 1, model_name: 'gpt-image-1-official',
            } : null,
          };
        },
      };
    },
  } as unknown as D1Database;
  return { DB, CONFIG_ENCRYPTION_KEY: encryption };
}

test('GEO uses the encrypted owner connection and only advertises eligible model families', async () => {
  const env = await environment();
  let paidCalls = 0;
  const connection = await readGeoAIConnection(owner, env, async (input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${key}`);
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'GET') {
      assert.equal(String(input), 'https://api.apimart.ai/v1/models?expand=category&category=chat');
      return Response.json({ data: [
        { id: 'deepseek-v4-flash', category: 'chat' }, { id: 'deepseek-v4.1-flash', category: 'chat' },
        { id: 'gpt-4o-mini', category: 'chat' }, { id: 'doubao-seed-1.8-lite', category: 'image' },
        { id: 'gpt-image-1-official', category: 'image' }, { id: 'gemini-2.5-flash-image', category: 'chat' },
      ] });
    }
    paidCalls++;
    assert.equal(String(input), 'https://api.apimart.ai/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.messages, [{ role: 'user', content: '通用选型问题' }]);
    assert.equal(body.model, paidCalls === 1 ? 'deepseek-v4.1-flash' : 'deepseek-v4-flash');
    return Response.json({ id: 'chatcmpl_test', choices: [{
      finish_reason: 'stop', message: { content: '通用答案 https://example.org/made-up' },
    }] });
  });
  assert.ok(connection);
  assert.deepEqual(connection.engines, ['DeepSeek', 'ChatGPT']);
  assert.equal(connection.generationModel, 'deepseek-v4.1-flash');
  assert.ok(connection.supports(' deepseek '));
  assert.equal(connection.models['deepseek-v4-flash'].model, 'deepseek-v4-flash');
  assert.equal(await readGeoAIConnection('another-owner', env, async () => assert.fail('Cross-owner fetch')), null);
  await assert.rejects(connection.capture('豆包', '通用选型问题'), { status: 404 });
  const sample = await connection.capture('DeepSeek', '通用选型问题');
  assert.equal(sample.model, 'deepseek-v4.1-flash');
  assert.equal(sample.webSearch, false);
  assert.equal(sample.requestId, 'chatcmpl_test');
  assert.deepEqual(sample.citations, []);
  await connection.capture('DeepSeek', '通用选型问题', { model: 'deepseek-v4-flash', webSearch: false });
  await assert.rejects(connection.capture('DeepSeek', '通用选型问题', { model: 'deepseek-v4-removed' }), { status: 404 });
  assert.equal(paidCalls, 2);
});

test('Responses web sampling keeps only public structured citations and requires evidence of search', async () => {
  const env = await environment();
  let includeSearch = true;
  const connection = await readGeoAIConnection(owner, env, async (input, init) => {
    if (init?.method === 'GET') return Response.json({ data: [{ id: 'gpt-5.2-pro', category: 'chat' }] });
    assert.equal(String(input), 'https://api.apimart.ai/v1/responses');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.equal(body.input, '本轮用户原文');
    const cited = { type: 'url_citation', url: 'https://www.example.org/standard', title: '官方资料' };
    return Response.json({ id: 'resp_test', status: 'completed', output: [
      ...(includeSearch ? [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://other.example.org/' }] } }] : []),
      { type: 'message', role: 'assistant', content: [{
        type: 'output_text', text: '正文 https://example.org/made-up',
        annotations: includeSearch ? [cited, cited, { ...cited, url: 'https://private.local/' }, { ...cited, url: 'http://example.org/' }] : [],
      }] },
    ] });
  });
  assert.ok(connection);
  assert.deepEqual(connection.engines, ['ChatGPT 联网']);
  const result = await connection.capture('ChatGPT 联网', '本轮用户原文');
  assert.equal(result.webSearch, true);
  assert.deepEqual(result.citations, [{ url: 'https://www.example.org/standard', title: '官方资料' }]);
  includeSearch = false;
  await assert.rejects(connection.capture('ChatGPT 联网', '本轮用户原文'), { status: 502, message: /未返回联网执行记录/ });
});

test('GEO never echoes provider errors or attempts a request with disabled credentials', async () => {
  const disabled = await environment(false);
  assert.equal(await readGeoAIConnection(owner, disabled, async () => assert.fail('Disabled credential used')), null);
  const env = await environment();
  await assert.rejects(
    readGeoAIConnection(owner, env, async () => new Response('provider token value', { status: 403 })),
    (error: Error & { status?: number }) => error.status === 403 && !error.message.includes('token'),
  );
});
