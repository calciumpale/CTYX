import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal, runOnce, validateJob } from '../tools/douyin-bridge/bridge-core.mjs';

const config = { origin: 'https://workbench.example', deviceId: 'device-1', deviceToken: 'device-token' };
const account = () => ({ authenticated: true, accountId: 'sender-1' });
const job = (id, retry) => ({ id, campaignId: 'campaign-1', kind: 'send', leaseToken: 'lease-1', input: { recipientId: 'recipient-1', profileUrl: 'https://www.douyin.com/user/recipient-1', message: '你好，想了解你的需求。', senderAccountId: 'sender-1', ...(retry ? { retry } : {}) } });
async function journalFor(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prospect-retry-'));
  const journal = await Journal.open(join(dir, 'journal.json'));
  t.after(async () => { await journal.close(); await rm(dir, { recursive: true, force: true }); });
  return journal;
}
async function prior(journal, outcome = 'unknown', dispatched = true, source = job('original')) {
  const entry = await journal.start(source);
  if (dispatched) await journal.dispatch(source);
  await journal.finish(source.id, { result: { outcome, error: outcome === 'submitted' ? undefined : '先前结果' } });
  journal.data.lastSendAt = 0;
  return entry;
}
async function execute(journal, next, send) {
  let polled, completed;
  await runOnce(config, { journal, adapter: { accountStatus: account, send }, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/poll')) { polled = body; return Response.json({ job: next }); }
    if (url.endsWith('/complete')) { completed = body.result; return Response.json({ ok: true }); }
    return Response.json({ ok: true });
  } });
  return { polled, completed };
}

test('retry jobs reject malformed lineage and advertise retry capability when polling', async t => {
  for (const retry of [{}, { previousJobId: 'retry' }, { previousJobId: 'original', checkSince: 'yesterday' }]) {
    assert.throws(() => validateJob(job('retry', retry)), { code: 'INVALID_RETRY' });
  }
  const journal = await journalFor(t);
  const { polled } = await execute(journal, null, () => {});
  assert.equal(polled.sendRetryVersion, 1);
});

test('an expressly reviewed unknown retry keeps old evidence and permits one new dispatch with the same approved content', async t => {
  const journal = await journalFor(t), old = await prior(journal);
  // Historical entries have only the original fingerprint and recipient reservation.
  delete old.sendFingerprint; delete old.retry;
  let sends = 0;
  const next = job('retry', { previousJobId: old.id, checkSince: old.startedAt });
  const { completed } = await execute(journal, next, async (input, { beforeDispatch }) => { await beforeDispatch(); sends++; return { outcome: 'submitted' }; });
  assert.equal(completed.outcome, 'submitted');
  assert.equal(sends, 1);
  assert.equal(journal.get(old.id).result.outcome, 'unknown');
  assert.ok(journal.get(next.id).dispatchedAt);
});

test('a verified pre-click failure can retry its unchanged message without an uncertain-history timestamp', async t => {
  const journal = await journalFor(t), old = await prior(journal, 'failed', false);
  let sends = 0;
  const { completed } = await execute(journal, job('retry', { previousJobId: old.id }), async (input, { beforeDispatch }) => { await beforeDispatch(); sends++; return { outcome: 'submitted' }; });
  assert.equal(completed.outcome, 'submitted'); assert.equal(sends, 1);
  assert.equal(journal.get(old.id).dispatchedAt, undefined);
});

test('retry cannot discard unknown history or alter the exact approved message', async t => {
  for (const mode of ['missing-since', 'changed-message', 'later-since']) {
    const journal = await journalFor(t), old = await prior(journal);
    const next = job(`retry-${mode}`, { previousJobId: old.id, ...(mode === 'missing-since' ? {} : { checkSince: mode === 'later-since' ? new Date(Date.parse(old.dispatchedAt) + 60000).toISOString() : old.startedAt }) });
    if (mode === 'changed-message') next.input.message = '另一条文案';
    let actions = 0;
    const { completed } = await execute(journal, next, async () => { actions++; return { outcome: 'submitted' }; });
    assert.equal(actions, 0, mode);
    assert.equal(completed.outcome, 'failed');
    assert.equal(journal.get(next.id).dispatchedAt, undefined);
  }
});

test('a pre-click failed retry remains bound to the earlier unknown ancestor', async t => {
  const journal = await journalFor(t), original = await prior(journal);
  const retry = job('retry-one', { previousJobId: original.id, checkSince: original.startedAt });
  await prior(journal, 'failed', false, retry);
  let sends = 0;
  const next = job('retry-two', { previousJobId: retry.id, checkSince: original.startedAt });
  const { completed } = await execute(journal, next, async (input, { beforeDispatch }) => { await beforeDispatch(); sends++; return { outcome: 'submitted' }; });
  assert.equal(completed.outcome, 'submitted'); assert.equal(sends, 1);
});

test('retry never bypasses a submitted ancestor or an unrelated unresolved recipient reservation', async t => {
  for (const mode of ['submitted', 'unrelated']) {
    const journal = await journalFor(t);
    const old = await prior(journal, mode === 'submitted' ? 'submitted' : 'unknown');
    if (mode === 'unrelated') {
      const sibling = await journal.start(job('unrelated'));
      sibling.recipientKey = old.recipientKey; sibling.dispatchedAt = old.dispatchedAt;
      await journal.finish(sibling.id, { result: { outcome: 'unknown' } });
    }
    let actions = 0;
    const { completed } = await execute(journal, job('retry', { previousJobId: old.id, checkSince: old.startedAt }), async () => { actions++; return { outcome: 'submitted' }; });
    assert.equal(actions, 0, mode); assert.equal(completed.outcome, 'failed');
  }
});

test('existing outgoing proof completes a reviewed retry without another dispatch but cannot complete an ordinary send', async t => {
  for (const retrying of [false, true]) {
    const journal = await journalFor(t);
    const old = retrying ? await prior(journal) : undefined;
    const next = job('next', old ? { previousJobId: old.id, checkSince: old.startedAt } : undefined);
    const { completed } = await execute(journal, next, async () => ({ outcome: 'submitted', alreadySubmitted: true, evidence: '已核对原会话中的己方同文消息' }));
    assert.equal(completed.outcome, retrying ? 'submitted' : 'failed');
    assert.equal(journal.get(next.id).dispatchedAt, undefined);
  }
});
