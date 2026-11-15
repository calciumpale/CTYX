import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptConnectionSecret } from '../app/lib/connection-config.ts';
import { readGeoAIConnection } from '../app/lib/geo-apimart.ts';
import { readGeoCaptureProvider } from '../app/lib/geo-capture-provider.ts';

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
    assert.equal(init?.redirect, 'manual');
    if (init?.method === 'GET') {
      assert.equal(String(input), 'https://api.apimart.ai/v1/models');
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

test('GEO uses the enabled workspace text connection when APIMart has no text models', async () => {
  const env = await environment();
  const model = { name: 'deepseek-flash', url: 'https://api.deepseek.com/chat/completions', key: 'workspace-key' };
  const seen: string[] = [];
  const provider = await readGeoCaptureProvider(owner, env, async () => model, async (input, init) => {
    seen.push(String(input));
    if (String(input) === 'https://api.apimart.ai/v1/models') return Response.json({
      data: [{ id: 'gpt-image-1-official', category: 'image' }],
    });
    assert.equal(String(input), model.url);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${model.key}`);
    assert.equal(JSON.parse(String(init?.body)).messages[0].content, '用原始问题采样。');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '选型时应结合使用条件。' } }] });
  });
  assert.equal(provider.apimart.status, 'no_text_models');
  assert.deepEqual(provider.engines, ['DeepSeek', 'DeepSeek 联网']);
  assert.equal(provider.models.DeepSeek.provider, 'workspace');
  const answer = await provider.capture('DeepSeek', '用原始问题采样。');
  assert.equal(answer.provider, 'workspace');
  assert.equal(answer.model, 'deepseek-flash');
  assert.equal(answer.webSearch, false);
  assert.equal(provider.supports?.('DeepSeek', { provider: 'apimart' }), false);
  await assert.rejects(provider.capture('DeepSeek', '用原始问题采样。', { provider: 'workspace', model: 'deepseek-chat' }), { status: 404 });
  assert.deepEqual(seen, ['https://api.apimart.ai/v1/models', model.url]);
});

test('direct DeepSeek web samples retain cited evidence, never ordinary generated links', async () => {
  const env = await environment(false);
  const model = { name: 'deepseek-flash', url: 'https://api.deepseek.com/chat/completions', key: 'workspace-key' };
  let searched = true;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), model.url);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages[0].content, '查找今天的公开资料。');
    assert.deepEqual(body.tools, [{ type: 'deepseek_web_search' }]);
    return Response.json({ id: 'search-123', choices: [{ finish_reason: 'stop', message: {
      content: '模型回答 https://example.org/generated',
      server_tool_calls: [{ calls: [{ type: 'deepseek_web_search', status: searched ? 'completed' : 'failed' }] }],
      annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.org/public', title: '公开资料' } }],
    } }] });
  };
  const provider = await readGeoCaptureProvider(owner, env, async () => model, fetcher);
  const selection = { provider: 'workspace', model: 'deepseek-flash', webSearch: true } as const;
  assert.ok(provider.supports?.('DeepSeek 联网', selection));
  assert.equal(provider.supports?.('DeepSeek', selection), false);
  const result = await provider.capture('DeepSeek 联网', '查找今天的公开资料。', selection);
  assert.equal(result.webSearch, true);
  assert.deepEqual(result.citations, [{ url: 'https://example.org/public', title: '公开资料' }]);
  searched = false;
  await assert.rejects(provider.capture('DeepSeek 联网', '查找今天的公开资料。', selection), { status: 400 });
  const relay = await readGeoCaptureProvider(owner, env, async () => ({ ...model, url: 'https://relay.example.org/v1/chat/completions' }), fetcher);
  assert.deepEqual(relay.engines, ['DeepSeek']);
});
