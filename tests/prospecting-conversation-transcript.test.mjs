import test from 'node:test';
import assert from 'node:assert/strict';
import { readConversationTranscript } from '../tools/douyin-bridge/conversation-transcript.mjs';

const browserTest = process.env.PROSPECT_BROWSER_TEST === '1' ? test : test.skip;
const identity = { senderAccountId: 'sender-1', recipientId: 'recipient-1', conversationId: 'conversation-1', limit: 50 };
const row = (index, direction, text, extra = '') => `<div data-index="${index}"><div class="messageMessageBoxmessageBox" ${direction ? `data-message-direction="${direction}"` : ''} ${extra}><span data-e2e="message-text">${text}</span></div></div>`;
const groupedStackRow = (outgoing, text) => `<div data-index="0"><div class="messageMessageBoxmessageBox messageMessageBoxlargeMargin messageMessageBoxstackLayout"><div class="messageMessageBoxselectableRow"><div class="messageMessageBoxcontentBox messageMessageBoxstackLayout" style="display:flex;flex-direction:${outgoing ? 'row-reverse' : 'row'};width:500px;gap:8px"><div class="messageMessageBoxstackLayoutHideAvatar" style="width:32px;height:32px;flex-shrink:0;display:block"></div><div class="MessageBoxContentcolumnBox" style="width:180px;flex:none"><span class="TextMessageTextpureText">${text}</span></div></div></div></div></div>`;
async function fixture(t, content) {
  const { chromium } = await import('../tools/douyin-bridge/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
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

for (const outgoing of [false, true]) browserTest(`a grouped ${outgoing ? 'outbound' : 'inbound'} stack bubble proves its own direction from the reserved avatar slot`, async t => {
  const text = outgoing ? '我会继续帮您了解需求。' : '这么晚了还没睡啊';
  const { read } = await fixture(t, groupedStackRow(outgoing, text) + row(1, outgoing ? 'incoming' : 'outgoing', '相邻消息来自另一侧'));
  const result = await read({ includeProof: true });
  assert.equal(result.reliable, true);
  assert.equal(result.covered, true);
  assert.equal(result.messages.at(-1)?.direction, outgoing ? 'outbound' : 'inbound');
  assert.equal(result.messages.at(-1)?.text, text);
});

browserTest('ambiguous or unrelated avatar placeholders never establish a message direction', async t => {
  const valid = groupedStackRow(false, '待核实的正文');
  const marker = '<div class="messageMessageBoxstackLayoutHideAvatar" style="width:32px;height:32px;flex-shrink:0;display:block"></div>';
  const cases = [
    valid.replace(marker, marker + marker),
    valid.replace('width:32px;height:32px', 'width:0px;height:0px'),
    valid.replace('width:32px;height:32px', 'width:60px;height:60px'),
    valid.replace('flex-shrink:0;display:block', 'flex-shrink:0;display:none'),
    valid.replace('flex-shrink:0;display:block', 'flex-shrink:0;display:block;visibility:hidden'),
    valid.replace(marker, marker.replace('<div ', '<span ').replace('</div>', '</span>')),
    valid.replace(marker, `<div>${marker}</div>`),
    valid.replace('messageMessageBoxlargeMargin messageMessageBoxstackLayout', 'messageMessageBoxlargeMargin'),
    valid.replace('messageMessageBoxcontentBox messageMessageBoxstackLayout', 'messageMessageBoxcontentBox'),
    valid.replace(marker, marker.replace('></div>', '>并非空占位</div>')),
    valid.replace('messageMessageBoxstackLayoutHideAvatar', 'unrelated-spacer'),
    valid.replace('width:500px;gap:8px', 'width:500px;gap:8px;justify-content:center'),
    valid.replace('</span></div>', '</span></div><div style="width:100px">第二个正文气泡</div>'),
  ];
  for (const content of cases) {
    const { read } = await fixture(t, content);
    const result = await read();
    assert.equal(result.reliable, false);
    assert.equal(result.messages.length, 0);
  }
});

browserTest('a reserved avatar slot cannot establish direction for a body outside its own content row', async t => {
  const content = '<div data-index="0"><div class="messageMessageBoxmessageBox messageMessageBoxstackLayout"><div class="messageMessageBoxcontentBox messageMessageBoxstackLayout" style="display:flex;flex-direction:row;width:500px"><div class="messageMessageBoxstackLayoutHideAvatar" style="width:32px;height:32px;flex-shrink:0"></div></div><span data-e2e="message-text" style="display:block;margin-left:100px;width:180px">不属于此布局行的正文</span></div></div>';
  const { read } = await fixture(t, content);
  const result = await read();
  assert.equal(result.reliable, false);
  assert.equal(result.messages.length, 0);
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

browserTest('a prior image preserves its unknown content without blocking a newer text message', async t => {
  const image = '<div data-index="1"><div class="messageMessageBoxmessageBox" data-message-direction="incoming"><div data-e2e="msg-item-content"><img width="120" height="120" src="https://example.test/customer-image.png"></div></div></div>';
  const { read } = await fixture(t, row(0, 'incoming', '想了解商铺面积') + image);
  const result = await read({ includeProof: true });
  assert.equal(result.reliable, true);
  assert.equal(result.covered, true);
  assert.deepEqual(result.messages.map(m => [m.direction, m.text]), [
    ['inbound', '[图片消息，内容未识别]'], ['inbound', '想了解商铺面积'],
  ]);
  assert.equal(result.proof.rowKeys.length, 2);
});

browserTest('a latest image is represented opaquely for a safe clarification and never described from its URL', async t => {
  const image = '<div data-index="0"><div class="messageMessageBoxmessageBox" data-message-direction="incoming"><div data-e2e="msg-item-content"><img width="120" height="120" src="https://example.test/sticker-hi.png"></div></div></div>';
  const { read } = await fixture(t, image + row(1, 'incoming', '可以回答我吗'));
  const result = await read({ includeProof: true });
  assert.equal(result.reliable, true);
  assert.equal(result.covered, true);
  assert.equal(result.messages.at(-1)?.text, '[图片消息，内容未识别]');
  assert.equal(result.messages.at(-1)?.contentType, 'image');
  assert.doesNotMatch(result.messages.at(-1)?.text ?? '', /hi|嗨|你好/);
});

browserTest('mixed media, pending images and missing latest indices remain unsafe after a text message', async t => {
  const image = '<div data-index="1"><div class="messageMessageBoxmessageBox" data-message-direction="incoming"><div data-e2e="msg-item-content"><img width="120" height="120" src="https://example.test/customer-image.png"></div></div></div>';
  for (const content of [image.replace('<img', '图中预算8000元/月<img'), image.replace('<img', '<video></video><img'), image.replace('data-message-direction="incoming"', 'data-message-direction="incoming" data-message-status="pending"'), image.replace('data-index="1"', 'data-index="2"')]) {
    const { read } = await fixture(t, row(0, 'incoming', '想了解商铺面积') + content);
    assert.equal((await read()).reliable, false);
  }
});

browserTest('an image with an unproved author still blocks the transcript after newer text arrives', async t => {
  const image = '<div data-index="1"><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><img width="120" height="120" src="https://example.test/unknown-author.png"></div></div></div>';
  const { read } = await fixture(t, row(0, 'incoming', '想了解商铺面积') + image);
  const result = await read();
  assert.equal(result.reliable, false);
  assert.deepEqual(result.messages.map(m => m.text), ['想了解商铺面积']);
});

for (const outgoing of [false, true]) browserTest(`a grouped stack image retains its own proven ${outgoing ? 'outbound' : 'inbound'} direction`, async t => {
  const image=groupedStackRow(outgoing,'').replace('<span class="TextMessageTextpureText"></span>','<img width="120" height="120" src="https://example.test/opaque.png">');
  const {read}=await fixture(t,image);
  const result=await read();assert.equal(result.reliable,true);assert.equal(result.messages[0].direction,outgoing?'outbound':'inbound');assert.equal(result.messages[0].contentType,'image');
});

browserTest('an image that is itself the marked content node keeps its opaque type',async t=>{
 const content='<div data-index="0"><div class="messageMessageBoxmessageBox" data-message-direction="incoming"><img data-e2e="msg-item-content" width="120" height="120" src="https://example.test/content-image.png"></div></div>';
 const {read}=await fixture(t,content);const result=await read();assert.equal(result.reliable,true);assert.equal(result.messages[0].contentType,'image');
});
