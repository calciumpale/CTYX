import test from 'node:test';
import assert from 'node:assert/strict';
import { readConversationTranscript } from '../tools/douyin-bridge/conversation-transcript.mjs';

const browserTest = process.env.PROSPECT_BROWSER_TEST === '1' ? test : test.skip;
const identity = { senderAccountId: 'sender-1', recipientId: 'recipient-1', conversationId: 'conversation-1', limit: 50 };
const row = (index, direction, text, extra = '') => `<div data-index="${index}"><div class="messageMessageBoxmessageBox" ${direction ? `data-message-direction="${direction}"` : ''} ${extra}><span data-e2e="message-text">${text}</span></div></div>`;
async function fixture(t, content) {
  const { chromium } = await import('../tools/douyin-bridge/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<section role="dialog"><div class="messageMessageListwrapper"><div class="messageMessageListlist">${content}</div></div></section>`);
  const root = page.getByRole('dialog');
  return { page, root, read: overrides => readConversationTranscript(root, { ...identity, timeoutMs: 800, ...overrides }) };
}

browserTest('conversation messages separate proven inbound and outbound text and exclude system rows', async t => {
  const system = '<div data-index="2"><div class="messageMessageBoxmessageBox messageMessageBoxisFullRowCenterMessage">04/23 对方撤回了一条消息</div></div>';
  const { read } = await fixture(t, row(0, 'outgoing', '您好，想了解哪个位置？', 'data-message-id="msg-out"') + row(1, 'incoming', '海盐的铺面多少钱？', 'data-message-id="msg-in"') + system);
  const result = await read();
  assert.equal(result.reliable, true);
  assert.deepEqual(result.messages.map(message => [message.direction, message.text]), [['inbound', '海盐的铺面多少钱？'], ['outbound', '您好，想了解哪个位置？']]);
  assert.equal(result.senderAccountId, 'sender-1'); assert.equal(result.recipientId, 'recipient-1');
});

browserTest('an ambiguous row is never presented as an inbound message but changes the snapshot', async t => {
  const { page, read } = await fixture(t, row(0, '', '未能识别方向') + row(1, 'incoming', '有铺吗？'));
  const first = await read();
  assert.equal(first.reliable, false); assert.equal(first.messages.length, 1);
  assert.equal(first.covered, true);
  await page.locator('[data-index="0"] [data-e2e="message-text"]').evaluate(node => { node.textContent = '后来出现的新消息'; });
  const second = await read();
  assert.notEqual(second.snapshotId, first.snapshotId);
});

browserTest('snapshot and row IDs stay stable while repeated same-text messages retain distinct identities', async t => {
  const { read } = await fixture(t, row(0, 'incoming', '好的') + row(1, 'incoming', '好的'));
  const first = await read(), second = await read();
  assert.equal(first.snapshotId, second.snapshotId);
  assert.deepEqual(first.messages.map(x => x.id), second.messages.map(x => x.id));
  assert.equal(new Set(first.messages.map(x => x.id)).size, 2);
});

browserTest('visible avatar profile evidence can prove message authors without relying on nickname', async t => {
  const avatar = (user, text) => `<div class="messageMessageBoxmessageBox"><a data-e2e="message-avatar" href="https://www.douyin.com/user/${user}"><img width="28" height="28" alt="同名账号头像"></a><span data-e2e="message-text">${text}</span></div>`;
  const { read } = await fixture(t, `<div data-index="0">${avatar('sender-1', '本人发言')}</div><div data-index="1">${avatar('recipient-1', '对方来信')}</div>`);
  assert.deepEqual((await read()).messages.map(x => x.direction), ['inbound', 'outbound']);
});

browserTest('message layout requires a clear avatar-bubble order and rejects centered or conflicting evidence', async t => {
  const avatar = '<div data-apm-action="个人页卡片" style="width:30px;height:30px;flex:none"><img width="30" height="30" alt="头像"></div>';
  const bubble = '<div data-e2e="message-text" style="width:160px;height:32px;flex:none">清楚的气泡正文</div>';
  const outgoing = `<div data-index="0"><div class="messageMessageBoxmessageBox" style="display:flex;flex-direction:row-reverse;width:500px;gap:8px">${avatar}${bubble}</div></div>`;
  const { read } = await fixture(t, outgoing);
  const result = await read(); assert.equal(result.reliable, true); assert.equal(result.messages[0].direction, 'outbound');
  const plain = await fixture(t, outgoing.replace('data-e2e="message-text"', '').replace('class="messageMessageBoxmessageBox"', 'class="messageMessageBoxmessageBox messageMessageBoxstackLayout messageMessageBoxisFirst"'));
  assert.equal((await plain.read()).messages[0]?.direction, 'outbound');
});

browserTest('current stack chat resolves authors from the nested content row and extracts only the canonical bubble', async t => {
  const stackRow = (index, outgoing, text) => `<div data-index="${index}"><div class="messageMessageBoxmessageBox messageMessageBoxstackLayout" style="display:block;width:500px">
    <div class="MessageBoxTimetimeLayout">昨天 09:42</div><div class="messageMessageBoxselectableRow">
      <div class="messageMessageBoxcontentBox messageMessageBoxstackLayout ${outgoing ? 'messageMessageBoxisFromMe' : ''}" style="display:flex;flex-direction:${outgoing ? 'row-reverse' : 'row'};width:500px;gap:8px">
        <div data-apm-action="个人页卡片" style="width:32px;height:32px;flex:none"><img width="32" height="32" alt="头像"></div>
        <div class="MessageBoxContentcolumnBox ${outgoing ? 'MessageBoxContentisFromMe' : ''}" style="width:180px;flex:none"><div class="MessageBoxContentrowBox">
          <div data-e2e="msg-item-content" class="MessageBoxContentactiveClickArea MessageBoxContentstackLayout">${text}</div>
        </div></div>
      </div>
    </div></div></div>`;
  const system = '<div data-index="2"><div class="messageMessageBoxmessageBox messageMessageBoxisFullRowCenterMessage">对方撤回了一条消息</div></div>';
  const { page, read } = await fixture(t, stackRow(0, true, '周六下午可以约看。') + stackRow(1, false, '什么时候方便看铺？') + system);
  await page.locator('.messageMessageListlist').evaluate(node => { node.style.display = 'flex'; node.style.flexDirection = 'column-reverse'; });
  const result = await read({ includeProof: true });
  assert.equal(result.reliable, true); assert.equal(result.covered, true);
  assert.deepEqual(result.messages.map(({ direction, text }) => ({ direction, text })), [
    { direction: 'inbound', text: '什么时候方便看铺？' }, { direction: 'outbound', text: '周六下午可以约看。' },
  ]);
  assert.equal(result.proof.rowKeys.length, 3);
});

browserTest('loading, virtualization gaps, unsupported content and truncated output are not reliable agent context', async t => {
  for (const html of ['', row(2, 'incoming', '不是最新页'), row(0, 'incoming', '')]) {
    const { read } = await fixture(t, html); assert.equal((await read()).reliable, false);
  }
  const { read } = await fixture(t, row(0, 'incoming', '最新一条') + row(1, 'outgoing', '较早一条'));
  const limited = await read({ limit: 1 }); assert.equal(limited.messages.length, 1); assert.equal(limited.reliable, false);
});

browserTest('delivery indicators stay out of sent messages while ordinary customer wording is preserved', async t => {
  for (const status of ['pending', 'failed']) {
    const { read } = await fixture(t, row(0, 'outgoing', '正在核对的正文', `data-message-status="${status}"`));
    const result = await read({ includeProof: true });
    assert.equal(result.messages.length, 0); assert.equal(result.reliable, false); assert.equal(result.proof.rowKeys.length, 1);
  }
  const { read } = await fixture(t, row(0, 'incoming', '刚才消息发送失败了吗？'));
  const result = await read(); assert.equal(result.reliable, true); assert.equal(result.messages[0].text, '刚才消息发送失败了吗？');
});

browserTest('direction becoming known does not turn an existing row into a newly observed outgoing proof', async t => {
  const { page, read } = await fixture(t, row(0, '', '同一条正文'));
  const before = await read({ includeProof: true });
  await page.locator('.messageMessageBoxmessageBox').evaluate(node => node.setAttribute('data-message-direction', 'outgoing'));
  const after = await read({ includeProof: true });
  assert.equal(after.proof.covered, true); assert.equal(after.messages[0].direction, 'outbound');
  assert.equal(after.covered, after.proof.covered);
  assert.deepEqual(after.proof.rowKeys, before.proof.rowKeys);
  assert.equal(after.proof.messageKeys[after.messages[0].id], before.proof.rowKeys[0]);
});

browserTest('missing latest rows cannot grant manual-reply coverage even when the observed rows are stable', async t => {
  const { read } = await fixture(t, row(2, 'incoming', '较早的可见消息'));
  const result = await read({ includeProof: true });
  assert.equal(result.covered, false); assert.equal(result.proof.covered, false);
});
