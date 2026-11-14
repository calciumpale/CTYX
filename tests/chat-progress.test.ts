import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import {
  CHAT_PROGRESS_CONTENT_TYPE, ChatProgressError, acceptsChatProgress,
  createChatProgressStream, readChatProgress, upsertChatProgressStep,
  type ChatProgressStep,
} from '../app/lib/chat-progress.ts';
import { createSeed } from '../app/lib/seed.ts';
import { DomainError } from '../app/lib/domain.ts';
import type { ApiResult } from '../app/lib/types.ts';

const result: ApiResult = JSON.parse(JSON.stringify({ state: createSeed('2026-06-10T00:00:00.000Z') }));
const running: ChatProgressStep = { id: 'model', title: '调用模型', detail: '正在生成回复', status: 'running', duration: 0 };
const success = { ...running, detail: '已调用模型', status: 'success', duration: 123 } as const;
const decoder = new TextDecoder();
const headers = { 'Content-Type': CHAT_PROGRESS_CONTENT_TYPE };

test('requires an explicit accepted NDJSON media type', () => {
  assert.equal(acceptsChatProgress('*/*'), false);
  assert.equal(acceptsChatProgress('application/json'), false);
  assert.equal(acceptsChatProgress('application/x-ndjson;q=0, */*'), false);
  assert.equal(acceptsChatProgress('application/json, Application/X-NDJSON ; q=0.2'), true);
});

test('publishes running steps before the once-only mutation resolves', async () => {
  let executions = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const stream = createChatProgressStream(async emit => {
    executions++;
    emit({ ...running, ...{ input: 'raw prompt', output: 'raw provider body' } });
    await gate;
    emit(success);
    return result;
  }, () => ({ status: 500, error: 'unexpected' }), () => {});
  const reader = stream.getReader();
  const first = await reader.read();
  assert.deepEqual(JSON.parse(decoder.decode(first.value)), { type: 'step', step: running });
  assert.equal(executions, 1);
  finish();
  assert.deepEqual(JSON.parse(decoder.decode((await reader.read()).value)), { type: 'step', step: success });
  assert.deepEqual(JSON.parse(decoder.decode((await reader.read()).value)), { type: 'complete', result });
  assert.equal((await reader.read()).done, true);
  assert.equal(executions, 1);
});

test('keeps the single mutation alive after the client stops reading', async () => {
  let saves = 0;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let active!: Promise<unknown>;
  const stream = createChatProgressStream(async emit => {
    emit(running);
    await gate;
    saves++;
    emit(success);
    return result;
  }, () => ({ status: 500, error: 'unexpected' }), work => { active = work; });
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel();
  finish();
  await active;
  assert.equal(saves, 1);
  assert.equal((await reader.read()).done, true);
});

test('reads split UTF-8 records and upserts the stable step in original order', async () => {
  const other = { ...success, id: 'knowledge', title: '检索知识' };
  const payload = [other, running, success].map(step => JSON.stringify({ type: 'step', step })).join('\r\n') +
    '\r\n\r\n' + JSON.stringify({ type: 'complete', result });
  const bytes = new TextEncoder().encode(payload);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 57) controller.enqueue(bytes.slice(offset, offset + 57));
      controller.close();
    },
  });
  let steps: ChatProgressStep[] = [];
  assert.deepEqual(await readChatProgress(new Response(stream, { headers }), step => {
    steps = upsertChatProgressStep(steps, step);
  }), result);
  assert.deepEqual(steps, [other, success]);
});

test('reads normal JSON results and preserves HTTP and streamed conflicts', async () => {
  assert.deepEqual(await readChatProgress(Response.json(result)), result);
  const safe = '工作空间已更新，请刷新后重试';
  await assert.rejects(readChatProgress(Response.json({ error: safe }, { status: 409 })), (error: unknown) =>
    error instanceof ChatProgressError && error.status === 409 && error.message === safe && !error.outcomeUnknown);
  const stream = createChatProgressStream(async () => { throw new Error('raw database detail'); },
    () => ({ status: 409, error: safe }), () => {});
  await assert.rejects(readChatProgress(new Response(stream, { headers })), (error: unknown) =>
    error instanceof ChatProgressError && error.status === 409 && error.message === safe && !error.outcomeUnknown);
});

test('treats truncation, invalid frames and transport failures as an unknown save outcome', async () => {
  const step = JSON.stringify({ type: 'step', step: running });
  const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('internal transport detail')); } });
  for (const body of [step, 'not ndjson', '{"type":"complete","result":{"state":{}}}', broken]) {
    await assert.rejects(readChatProgress(new Response(body, { headers })), (error: unknown) =>
      error instanceof ChatProgressError && error.outcomeUnknown && /刷新/.test(error.message) && !/internal/.test(error.message));
  }
});

test('POST negotiates chat streaming and shares the one authorized mutation with JSON requests', async () => {
  const work: Promise<void>[] = [];
  const calls: { user: string; action: string; revision: unknown; member: string; streamed: boolean }[] = [];
  let saveGate: Promise<void> | undefined;
  let saves = 0;
  const salesOwners = [{ salesId: 'sales-route', displayName: '测试销售' }];
  const appStubs = {
    waitUntil: (promise: Promise<void>) => { work.push(promise); },
    requireUserId: (request: Request) => {
      const id = request.headers.get('oai-authenticated-user-id');
      if (!id) throw new DomainError('请先登录工作台', 401);
      return id;
    },
    readRole: () => 'manager',
    readSalesOwners: async () => salesOwners,
    loadWorkspace: async () => result.state,
    mutateWorkbench: async (
      user: string, _role: string, action: string, _payload: unknown, revision: unknown,
      _origin: string, _memberRole: string, _memberName: string, _salesScope: unknown, member: string,
      progress?: (step: ChatProgressStep) => void,
    ) => {
      calls.push({ user, action, revision, member, streamed: !!progress });
      if (revision !== result.state.revision) throw new DomainError('工作空间已更新，请刷新后重试', 409);
      progress?.(running);
      await saveGate;
      saves++;
      progress?.(success);
      return structuredClone(result);
    },
  };
  const key = Symbol.for('workbench.test.chatProgressRoute');
  Reflect.set(globalThis, key, appStubs);
  const stubModule = (exports: string[]) => 'data:text/javascript,' + encodeURIComponent(exports.map(name =>
    `export const ${name}=globalThis[Symbol.for('workbench.test.chatProgressRoute')].${name};`).join('\n'));
  const loader = `
    export async function resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('/app/api/workbench/route.ts')) {
        if (specifier === 'cloudflare:workers') return { shortCircuit: true, url: ${JSON.stringify(stubModule(['waitUntil']))} };
        if (specifier === '../../lib/server.ts') return { shortCircuit: true, url: ${JSON.stringify(stubModule([
          'readSalesOwners', 'loadWorkspace', 'mutateWorkbench', 'readRole', 'requireUserId',
        ]))} };
      }
      return next(specifier, context);
    }`;
  register('data:text/javascript,' + encodeURIComponent(loader), import.meta.url);
  try {
    const { POST } = await import('../app/api/workbench/route.ts');
    const origin = 'https://workbench.example.net';
    const request = (action: string, revision: number, extra: Record<string, string> = {}) =>
      new Request(origin + '/api/workbench', {
        method: 'POST', body: JSON.stringify({ action, revision, payload: { query: '客户情况' } }),
        headers: { 'Content-Type': 'application/json', origin, 'oai-authenticated-user-id': 'owner',
          'x-ctai-member-authenticated': '1', 'x-ctai-member-role': 'manager', 'x-ctai-member-account-id': 'member',
          'x-ctai-member-username': 'member', ...extra },
      });
    const optIn = { Accept: CHAT_PROGRESS_CONTENT_TYPE };
    for (const [extra, status] of [
      [{ ...optIn, 'oai-authenticated-user-id': '' }, 401],
      [{ ...optIn, 'x-ctai-member-role': 'admin' }, 403],
      [{ ...optIn, origin: 'https://outside.example.net' }, 403],
    ] as const) {
      const rejection = await POST(request('chat', result.state.revision, extra));
      assert.equal(rejection.status, status);
      assert.match(rejection.headers.get('Content-Type') ?? '', /^application\/json/);
    }
    assert.equal(calls.length, 0);
    const stale = await POST(request('chat', result.state.revision + 1, optIn));
    assert.equal(stale.status, 200);
    await assert.rejects(readChatProgress(stale), (error: unknown) =>
      error instanceof ChatProgressError && error.status === 409 && !error.outcomeUnknown);
    assert.equal(saves, 0);

    let finish!: () => void;
    saveGate = new Promise<void>(resolve => { finish = resolve; });
    const streaming = await POST(request('chat', result.state.revision, optIn));
    assert.match(streaming.headers.get('Content-Type') ?? '', /^application\/x-ndjson/);
    assert.match(streaming.headers.get('Cache-Control') ?? '', /no-transform/);
    let sawRunning!: () => void;
    const firstProgress = new Promise<void>(resolve => { sawRunning = resolve; });
    const progress: ChatProgressStep[] = [];
    const response = readChatProgress(streaming, step => {
      progress.push(step);
      sawRunning();
    });
    await Promise.race([firstProgress, response.then(() => assert.fail('Received result before a progress step'))]);
    assert.deepEqual(progress, [running]);
    assert.equal(saves, 0);
    finish();
    assert.deepEqual((await response).state.salesOwners, salesOwners);
    assert.deepEqual(progress, [running, success]);
    assert.equal(saves, 1);

    for (const [action, extra] of [['chat', {}], ['deal_note', optIn]] as const) {
      const response = await POST(request(action, result.state.revision, extra));
      assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
      assert.deepEqual((await readChatProgress(response)).state.salesOwners, salesOwners);
    }
    await Promise.all(work);
    assert.equal(work.length, 2);
    assert.equal(saves, 3);
    assert.deepEqual(calls.map(({ user, member, action, streamed }) => ({ user, member, action, streamed })), [
      { user: 'owner', member: 'member', action: 'chat', streamed: true },
      { user: 'owner', member: 'member', action: 'chat', streamed: true },
      { user: 'owner', member: 'member', action: 'chat', streamed: false },
      { user: 'owner', member: 'member', action: 'deal_note', streamed: false },
    ]);
  } finally {
    Reflect.deleteProperty(globalThis, key);
  }
});
