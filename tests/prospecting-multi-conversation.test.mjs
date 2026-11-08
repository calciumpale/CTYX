import test from 'node:test';
import assert from 'node:assert/strict';
import { DouyinBrowserAdapter } from '../tools/douyin-bridge/browser-adapter.mjs';

const browserTest = process.env.PROSPECT_BROWSER_TEST === '1' ? test : test.skip;
const input = recipientId => ({ senderAccountId: 'sender-1', recipientId,
  profileUrl: `https://www.douyin.com/user/${recipientId}`, conversationId: `conversation-${recipientId}`, limit: 50 });

// All requests are fulfilled locally. Composers and send buttons below are
// synthetic DOM only: no existing browser, cookie, account, or platform request.
async function fixture(t, { staleRecipient, wrongProfileFor } = {}) {
  const { chromium } = await import('../tools/douyin-bridge/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://www.douyin.com') return route.abort();
    const recipientId = url.pathname.slice('/user/'.length);
    const shown = staleRecipient ?? recipientId;
    const profileId = wrongProfileFor === shown ? 'unrelated-user' : shown;
    const selectedProfileId = wrongProfileFor === recipientId ? 'unrelated-user' : recipientId;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
      <header><a aria-label="我的主页" href="/user/sender-1">本人</a></header>
      <main><h1>${recipientId}</h1>
        <button id="private-message" onclick="window.entryClicks=(window.entryClicks||0)+1;
          const root=document.querySelector('[data-stack-layer=chat]');
          if(root.dataset.recipientId!=='${recipientId}') {
            root.dataset.recipientId='${recipientId}';
            root.querySelector('[data-e2e=message-text]').textContent='${recipientId}的来信';
            root.querySelector('[data-message-id]').dataset.messageId='${recipientId}-inbound';
          }
          root.querySelector('[data-apm-action]').textContent='${recipientId}';
          root.querySelector('[data-apm-action]').onclick=()=>{
            window.proofClicks=(window.proofClicks||0)+1; window.open('/user/${selectedProfileId}');
          }">私信</button>
        <div data-e2e="im-dialog"><section data-stack-layer="chat" data-recipient-id="${shown}">
          <div class="StackLayoutStackChatHeaderuser"><button data-apm-action="个人页卡片"
            onclick="window.proofClicks=(window.proofClicks||0)+1; window.open('/user/${profileId}')">${shown}</button></div>
          <div class="messageMessageListwrapper"><div class="messageMessageListlist">
            <div data-index="0"><div class="messageMessageBoxmessageBox" data-message-id="${shown}-inbound" data-message-direction="incoming">
              <span data-e2e="message-text">${shown}的来信</span>
            </div></div>
          </div></div>
          <div data-e2e="msg-input"><div contenteditable="true">保留的草稿</div>
            <button class="e2e-send-msg-btn" onclick="
              const root=this.closest('[data-stack-layer=chat]');
              const recipientId=root.dataset.recipientId;
              const text=root.querySelector('[contenteditable]').innerText;
              window.syntheticSends.push({recipientId,text});
              sessionStorage.setItem('syntheticSends',JSON.stringify(window.syntheticSends));
              const list=root.querySelector('.messageMessageListlist');
              for(const old of list.querySelectorAll('[data-index]'))old.dataset.index=Number(old.dataset.index)+1;
              const slot=document.createElement('div');slot.dataset.index='0';
              const row=document.createElement('div');row.className='messageMessageBoxmessageBox';
              row.dataset.messageId=recipientId+'-outbound-'+window.syntheticSends.length;
              row.dataset.messageDirection='outgoing';
              const body=document.createElement('span');body.dataset.e2e='message-text';body.textContent=text;
              row.append(body);slot.append(row);list.prepend(slot)">发送</button>
          </div>
        </section></div>
      </main><script>window.syntheticSends=JSON.parse(sessionStorage.getItem('syntheticSends')||'[]');</script></body></html>` });
  });
  const adapter = new DouyinBrowserAdapter(context, { timeoutMs: 800, confirmationMs: 700 });
  return { adapter, context };
}

browserTest('opening recipient A switches a still-visible recipient B panel through the A private-message entry', async t => {
  const { adapter } = await fixture(t, { staleRecipient: 'recipient-b' });
  const page = await adapter.navigate(input('recipient-a').profileUrl);
  try {
    const observed = await adapter.readConversation(input('recipient-a'));
    assert.equal(observed.reliable, true);
    assert.equal(observed.recipientId, 'recipient-a');
    assert.equal(observed.messages[0].text, 'recipient-a的来信');
    assert.equal(await page.locator('[contenteditable]').innerText(), '保留的草稿');
  } finally {
    t.diagnostic(JSON.stringify(await page.evaluate(() => ({ entryClicks: window.entryClicks || 0,
      header: document.querySelector('.StackLayoutStackChatHeaderuser').innerText,
      proofClicks: window.proofClicks || 0 }))));
  }
});

browserTest('normal A then B then A polling gives each requested recipient a fresh participant proof', async t => {
  const { adapter } = await fixture(t);
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const observations = [];
  for (const recipientId of ['recipient-a', 'recipient-b', 'recipient-a']) {
    try {
      const observed = await adapter.readConversation(input(recipientId));
      observations.push({ recipientId, reliable: observed.reliable, text: observed.messages[0]?.text });
    } catch (error) { observations.push({ recipientId, error: error.code }); }
    offset += 30001;
  }
  assert.deepEqual(observations, [
    { recipientId: 'recipient-a', reliable: true, text: 'recipient-a的来信' },
    { recipientId: 'recipient-b', reliable: true, text: 'recipient-b的来信' },
    { recipientId: 'recipient-a', reliable: true, text: 'recipient-a的来信' },
  ]);
});

browserTest('a failed profile proof for A does not suppress a correct B participant proof on the next read', async t => {
  const { adapter } = await fixture(t, { wrongProfileFor: 'recipient-a' });
  await assert.rejects(adapter.readConversation(input('recipient-a')), { code: 'RECIPIENT_UNVERIFIED' });
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => realNow() + 15001);
  const observed = await adapter.readConversation(input('recipient-b'));
  assert.equal(observed.reliable, true);
  assert.equal(observed.recipientId, 'recipient-b');
  assert.equal(observed.messages[0].text, 'recipient-b的来信');
});

browserTest('a failed A proof retains its own cooldown after B succeeds without reopening the A profile', async t => {
  const { adapter, context } = await fixture(t, { wrongProfileFor: 'recipient-a' });
  let popupCount = 0;
  context.on('page', page => { page.on('popup', () => { popupCount++; }); });
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  await assert.rejects(adapter.readConversation(input('recipient-a')), { code: 'RECIPIENT_UNVERIFIED' });
  assert.equal(popupCount, 1);
  const observed = await adapter.readConversation(input('recipient-b'));
  assert.equal(observed.reliable, true);
  assert.equal(observed.messages[0].text, 'recipient-b的来信');
  assert.equal(popupCount, 2);
  offset = 15001;
  await assert.rejects(adapter.readConversation(input('recipient-a')), { code: 'RECIPIENT_UNVERIFIED' });
  assert.equal(popupCount, 2, 'Changing recipients must not reset A\'s failed-proof cooldown');
});

browserTest('reading and replying to A then B dispatches each synthetic reply only to its own verified recipient', async t => {
  const { adapter } = await fixture(t, { staleRecipient: 'recipient-b' });
  const dispatches = [];
  for (const recipientId of ['recipient-a', 'recipient-b']) {
    const observed = await adapter.readConversation(input(recipientId));
    assert.equal(observed.reliable, true);
    assert.equal(observed.messages.at(-1).text, `${recipientId}的来信`);
    const result = await adapter.reply({ ...input(recipientId),
      message: `仅回复${recipientId}`, replyId: `reply-${recipientId}`, actor: 'agent', expectedSnapshotId: observed.snapshotId,
    }, { beforeDispatch: async proof => {
      assert.equal(proof.conversation.snapshotId, observed.snapshotId);
      dispatches.push(recipientId);
    } });
    assert.equal(result.outcome, 'submitted');
  }
  const page = await adapter.page();
  assert.deepEqual(dispatches, ['recipient-a', 'recipient-b']);
  assert.deepEqual(await page.evaluate(() => window.syntheticSends), [
    { recipientId: 'recipient-a', text: '仅回复recipient-a' },
    { recipientId: 'recipient-b', text: '仅回复recipient-b' },
  ]);
});
