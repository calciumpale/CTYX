import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeError, Journal, runOnce, validateJob } from '../tools/douyin-bridge/bridge-core.mjs';

const config = { origin: 'https://workbench.example', deviceId: 'device-1', deviceToken: 'device-token' };
const identity = { senderAccountId: 'sender-1', recipientId: 'recipient-1', profileUrl: 'https://www.douyin.com/user/recipient-1', conversationId: 'conversation-1' };
const job = (id, kind, extra = {}) => ({ id, campaignId: 'campaign-1', leaseToken: 'lease-1', kind, input: { ...identity, ...extra } });
const reply = (id, replyId = id) => job(id, 'reply', { message: '可以，明天下午方便吗？', replyId, expectedSnapshotId: 'snapshot-1', actor: 'agent' });

for (const dispatched of [false, true]) test(`temporary reply verification failure is retryable only before dispatch (${dispatched})`, async t => {
  const journal = await journalFor(t);
  const { completed } = await execute(journal, reply('temporary-proof'), { reply: async (_input, { beforeDispatch }) => {
    if (dispatched) await beforeDispatch();
    throw new BridgeError('暂未核实当前账号，请等待页面恢复。', 'ACCOUNT_VERIFICATION_PENDING');
  } });
  assert.equal(completed.result.outcome, dispatched ? 'unknown' : 'failed');
  assert.equal(completed.result.retryable === true, !dispatched);
  if (!dispatched) assert.equal(completed.result.errorCode, 'ACCOUNT_VERIFICATION_PENDING');
  assert.equal(Boolean(journal.get('temporary-proof').dispatchedAt), dispatched);
});
async function journalFor(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prospect-conversation-'));
  const journal = await Journal.open(join(dir, 'journal.json'));
  t.after(async () => { await journal.close(); await rm(dir, { recursive: true, force: true }); });
  return journal;
}
async function execute(journal, next, actions) {
  let polled, completed;
  await runOnce(config, { journal, adapter: { accountStatus: () => ({ authenticated: true, accountId: 'sender-1' }), ...actions }, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/poll')) { polled = body; return Response.json({ job: next }); }
    if (url.endsWith('/complete')) { completed = body; return Response.json({ ok: true }); }
    return Response.json({ ok: true });
  } });
  return { polled, completed };
}

for (const code of ['ACCOUNT_VERIFICATION_PENDING', 'UNAUTHENTICATED', 'ACCOUNT_CHANGED', 'CHAT_UNAVAILABLE']) {
  test(`a read ${code} records its failure and preserves the correct connection boundary`, async t => {
    const journal = await journalFor(t);
    let completed, polls = 0;
    const failure = new BridgeError('本次会话读取未完成，请重新核验后同步。', code);
    failure.verificationReason = 'account_read_interrupted';
    const operation = runOnce(config, { journal, adapter: {
      accountStatus: () => ({ authenticated: true, accountId: 'sender-1' }),
      readConversation: async () => { throw failure; },
    }, fetchImpl: async (url, options) => {
      if (url.endsWith('/poll')) { polls++; return Response.json({ job: job('failed-read', 'readConversation') }); }
      if (url.endsWith('/complete')) completed = JSON.parse(options.body);
      return Response.json({ ok: true });
    } });
    if (code === 'ACCOUNT_CHANGED') await assert.rejects(operation, error => error.code === 'ACCOUNT_CHANGED');
    else {
      const result = await operation;
      assert.equal(result.authenticated, code === 'CHAT_UNAVAILABLE');
      assert.equal(result.verificationPending === true, code === 'ACCOUNT_VERIFICATION_PENDING');
      if (code === 'ACCOUNT_VERIFICATION_PENDING') {
        assert.equal(result.needsAccountVerification, true);
        assert.equal(result.verificationReason, 'account_read_interrupted');
      }
    }
    assert.equal(polls, 1);
    assert.equal(completed.error, failure.message);
    assert.equal(completed.result, undefined);
    assert.equal(journal.get('failed-read').reported, true);
    assert.equal(journal.get('failed-read').dispatchedAt, undefined);
  });
}

test('conversation jobs validate exact account and target, bound reads, and require approved reply context', () => {
  assert.equal(validateJob(job('read', 'readConversation', { limit: 999 })).input.limit, 100);
  assert.equal(validateJob(reply('reply')).input.actor, 'agent');
  assert.equal(validateJob({ ...reply('human'), input: { ...reply('human').input, actor: 'human' } }).input.actor, 'human');
  for (const patch of [{ actor: 'system' }, { expectedSnapshotId: '' }, { replyId: '' }, { conversationId: '' }, { recipientId: 'other-user' }]) {
    assert.throws(() => validateJob({ ...reply('invalid'), input: { ...reply('invalid').input, ...patch } }));
  }
});

test('runner reads a verified conversation as a read-only job and advertises its protocol version', async t => {
  const journal = await journalFor(t);
  const result = { senderAccountId: 'sender-1', recipientId: 'recipient-1', observedAt: '2026-11-06T05:00:00.000Z', snapshotId: 'snapshot-1', reliable: true,
    messages: [{ id: 'incoming-1', direction: 'inbound', text: '这个铺面多少钱？' }, { id: 'outgoing-1', direction: 'outbound', text: '请问您想在哪个位置？' }] };
  const { polled, completed } = await execute(journal, job('read', 'readConversation', { limit: 50 }), { readConversation: async input => { assert.equal(input.recipientId, 'recipient-1'); return result; } });
  assert.equal(polled.conversationVersion, 1);
  assert.deepEqual(completed.result, result);
  assert.equal(journal.get('read').dispatchedAt, undefined);
});

test('runner preserves stable-window coverage independently of automatic reply reliability', async t => {
  for (const covered of [true, false]) {
    const journal = await journalFor(t);
    const result = { senderAccountId: 'sender-1', recipientId: 'recipient-1', observedAt: '2026-11-06T05:00:00.000Z', snapshotId: 'snapshot-1', reliable: false, covered, messages: [] };
    const { completed } = await execute(journal, job('read', 'readConversation'), { readConversation: async () => result });
    assert.deepEqual(completed.result, result);
  }
});

test('runner retains the typed opaque image without forwarding image content as text', async t => {
 const journal=await journalFor(t);
 const result={senderAccountId:'sender-1',recipientId:'recipient-1',observedAt:'2026-11-06T05:00:00.000Z',snapshotId:'snapshot-image',reliable:true,covered:true,messages:[{id:'image-1',direction:'inbound',text:'[图片消息，内容未识别]',contentType:'image'}]};
 const {completed}=await execute(journal,job('image-read','readConversation'),{readConversation:async()=>result});
 assert.deepEqual(completed.result,result);
});

test('runner rejects invented image text and unsupported content types before reporting a readable turn', async t => {
 for(const message of [{id:'image',direction:'inbound',text:'预算8000元/月',contentType:'image'},{id:'other',direction:'inbound',text:'未识别内容',contentType:'video'}]){
  const journal=await journalFor(t);const result={senderAccountId:'sender-1',recipientId:'recipient-1',observedAt:'2026-11-06T05:00:00.000Z',snapshotId:'snapshot-image',reliable:true,messages:[message]};
  const {completed}=await execute(journal,job('invalid-image-read','readConversation'),{readConversation:async()=>result});assert.ok(completed.error);assert.equal(completed.result,undefined);
 }
});

test('conversation output cannot reassign sender, recipient, or silently label ambiguous rows as inbound', async t => {
  for (const patch of [{ recipientId: 'another-user' }, { senderAccountId: 'another-account' }, { covered: 'true' }, { messages: [{ id: 'unknown', direction: 'unknown', text: '不能猜方向' }] }]) {
    const journal = await journalFor(t);
    const result = { senderAccountId: 'sender-1', recipientId: 'recipient-1', observedAt: '2026-11-06T05:00:00.000Z', snapshotId: 'snapshot-1', reliable: true, messages: [], ...patch };
    const { completed } = await execute(journal, job('read', 'readConversation'), { readConversation: async () => result });
    assert.ok(completed.error); assert.equal(completed.result, undefined);
  }
});

test('approved follow-up replies may follow a confirmed outreach while keeping their own single-dispatch key', async t => {
  const journal = await journalFor(t);
  const outreach = job('outreach', 'send', { message: '你好' });
  await journal.start(outreach); await journal.dispatch(outreach); await journal.finish(outreach.id, { result: { outcome: 'submitted' } }); journal.data.lastSendAt = 0;
  let clicks = 0;
  const send = async (input, { beforeDispatch }) => { await beforeDispatch(); clicks++; return { outcome: 'submitted' }; };
  assert.equal((await execute(journal, reply('followup'), { reply: send })).completed.result.outcome, 'submitted');
  journal.data.lastSendAt = 0;
  assert.equal((await execute(journal, reply('duplicate-job', 'followup'), { reply: send })).completed.result.outcome, 'failed');
  assert.equal(clicks, 1);
});

test('an unresolved first outreach or reply blocks another conversation reply before browser actions', async t => {
  for (const priorKind of ['send', 'reply']) {
    const journal = await journalFor(t), previous = priorKind === 'reply' ? reply('prior') : job('prior', 'send', { message: '你好' });
    await journal.start(previous); await journal.dispatch(previous); await journal.finish(previous.id, { result: { outcome: 'unknown' } }); journal.data.lastSendAt = 0;
    let actions = 0;
    const { completed } = await execute(journal, reply('followup'), { reply: async () => { actions++; return { outcome: 'submitted' }; } });
    assert.equal(actions, 0); assert.equal(completed.result.outcome, 'failed');
  }
});

test('a successfully reconciled outreach retry resolves only its own unknown ancestors for follow-up replies', async t => {
  const journal = await journalFor(t), original = job('original', 'send', { message: '你好' });
  const old = await journal.start(original); await journal.dispatch(original); await journal.finish(original.id, { result: { outcome: 'unknown' } }); journal.data.lastSendAt = 0;
  const retry = { ...original, id: 'reviewed-retry', input: { ...original.input, retry: { previousJobId: original.id, checkSince: old.startedAt } } };
  await journal.start(retry); await journal.dispatch(retry); await journal.finish(retry.id, { result: { outcome: 'submitted' } }); journal.data.lastSendAt = 0;
  let clicks = 0;
  const { completed } = await execute(journal, reply('followup'), { reply: async (input, { beforeDispatch }) => { await beforeDispatch(); clicks++; return { outcome: 'submitted' }; } });
  assert.equal(completed.result.outcome, 'submitted'); assert.equal(clicks, 1);
  assert.equal(journal.get(original.id).result.outcome, 'unknown');
});

test('a reply interrupted after its durable checkpoint is unknown and never executed again', async t => {
  const journal = await journalFor(t); let clicks = 0;
  const actions = { reply: async (input, { beforeDispatch }) => { await beforeDispatch(); clicks++; throw Error('page gone'); } };
  const next = reply('reply');
  assert.equal((await execute(journal, next, actions)).completed.result.outcome, 'unknown');
  await execute(journal, next, actions);
  assert.equal(clicks, 1); assert.equal(journal.get(next.id).result.outcome, 'unknown');
});

test('reply renews again after final browser verification so takeover prevents its durable dispatch', async t => {
  const journal = await journalFor(t); let renewals = 0, clicks = 0, completed;
  await runOnce(config, { journal, adapter: { accountStatus: () => ({ authenticated: true, accountId: 'sender-1' }), reply: async (input, { renewBeforeDispatch, beforeDispatch }) => {
    await renewBeforeDispatch();
    await beforeDispatch(); clicks++; return { outcome: 'submitted' };
  } }, fetchImpl: async (url, options) => {
    if (url.endsWith('/poll')) return Response.json({ job: reply('reply') });
    if (url.endsWith('/heartbeat')) { renewals++; return Response.json({ ok: renewals === 1 }, { status: renewals === 1 ? 200 : 409 }); }
    completed = JSON.parse(options.body).result; return Response.json({ ok: true });
  } });
  assert.equal(renewals, 2); assert.equal(clicks, 0); assert.equal(completed.outcome, 'failed');
  assert.equal(journal.get('reply').dispatchedAt, undefined);
});

test('a reliable newer outgoing row reconciles an unknown reply locally without rewriting its original result', async t => {
  const journal = await journalFor(t), previous = reply('previous');
  await journal.start(previous);
  await journal.dispatch(previous, { conversation: { snapshotId: 'snapshot-1', covered: true, priorMessageKeys: ['visible:anchor'], latestMessageKey: 'visible:anchor' } });
  await journal.finish(previous.id, { result: { outcome: 'unknown', error: '等待核对' } }); journal.data.lastSendAt = 0;
  const observed = { senderAccountId: 'sender-1', recipientId: 'recipient-1', observedAt: new Date().toISOString(), snapshotId: 'snapshot-new', reliable: true,
    messages: [{ id: 'out-new', direction: 'outbound', text: previous.input.message }],
    proof: { covered: true, rowKeys: ['visible:anchor', 'native:new-out'], messageKeys: { 'out-new': 'native:new-out' } } };
  await execute(journal, job('read-new', 'readConversation'), { readConversation: async () => observed });
  assert.equal(journal.get(previous.id).result.outcome, 'unknown');
  assert.equal(journal.get(previous.id).reconciledBy.snapshotId, 'snapshot-new');
  let clicks = 0;
  const { completed } = await execute(journal, reply('followup'), { reply: async (input, { beforeDispatch }) => { await beforeDispatch(); clicks++; return { outcome: 'submitted' }; } });
  assert.equal(completed.result.outcome, 'submitted'); assert.equal(clicks, 1);
});

test('an older or inbound same-text row cannot clear an unknown reply reservation', async t => {
  for (const direction of ['outbound', 'inbound']) {
    const journal = await journalFor(t), previous = reply('previous');
    await journal.start(previous);
    await journal.dispatch(previous, { conversation: { snapshotId: 'snapshot-1', covered: true, priorMessageKeys: ['native:old-out', 'visible:anchor'], latestMessageKey: 'visible:anchor' } });
    await journal.finish(previous.id, { result: { outcome: 'unknown' } }); journal.data.lastSendAt = 0;
    await execute(journal, job('read-new', 'readConversation'), { readConversation: async () => ({ senderAccountId: 'sender-1', recipientId: 'recipient-1', observedAt: new Date().toISOString(), snapshotId: 'snapshot-new', reliable: true,
      messages: [{ id: 'same', direction, text: previous.input.message }], proof: { covered: true, rowKeys: ['native:old-out', 'visible:anchor', 'native:incoming'], messageKeys: { same: direction === 'outbound' ? 'native:old-out' : 'native:incoming' } } }) });
    assert.equal(journal.get(previous.id).reconciledBy, undefined);
  }
});

test('acknowledged read bodies are stripped and bounded while pending reports and outbound evidence survive', async t => {
  const journal = await journalFor(t);
  const observed = { senderAccountId: 'sender-1', recipientId: 'recipient-1', observedAt: '2026-11-06T05:00:00.000Z', snapshotId: 'snapshot-1', reliable: true, messages: [{ id: 'message-1', direction: 'inbound', text: '需要了解铺面的详细信息' }] };
  await execute(journal, job('read', 'readConversation'), { readConversation: async () => observed });
  const acknowledged = journal.get('read'); assert.equal(acknowledged.result.messages, undefined);
  const pending = { ...acknowledged, id: 'pending-read', reported: false, result: observed };
  journal.data.entries.push(pending);
  for (let index = 0; index < 450; index++) journal.data.entries.push({ ...acknowledged, id: `old-read-${index}`, result: { ...observed, messages: [{ ...observed.messages[0], text: '很长的已同步会话'.repeat(200) }] } });
  const outbound = await journal.start(reply('kept-outbound')); await journal.finish(outbound.id, { result: { outcome: 'unknown' } });
  await journal.save();
  assert.equal(journal.get('pending-read').result.messages[0].text, observed.messages[0].text);
  assert.equal(journal.get('kept-outbound').result.outcome, 'unknown');
  assert.ok(Buffer.byteLength(JSON.stringify(journal.data), 'utf8') < 200000);
});
