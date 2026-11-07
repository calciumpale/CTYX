import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRetryTranscript } from '../tools/douyin-bridge/retry-transcript.mjs';

const browserTest = process.env.PROSPECT_BROWSER_TEST === '1' ? test : test.skip;
const message = '你好，想进一步了解一下吗？';
const checkSince = '2026-11-06T03:19:37.675Z';
const row = (index, html, classes = '', attributes = '') =>
  `<div data-index="${index}"><div class="messageMessageBoxmessageBox ${classes}" ${attributes}>${html}</div></div>`;
const recalled = index => row(index, '<div>04/23</div><span>对方撤回了一条消息</span>', 'messageMessageBoxisFullRowCenterMessage');

async function inspect(t, html, since = checkSince) {
  const { chromium } = await import('../tools/douyin-bridge/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ timezoneId: 'Asia/Shanghai' });
  await page.clock.setFixedTime(new Date('2026-11-06T03:30:00Z'));
  await page.setContent(`<section role="dialog"><div class="messageMessageListwrapper"><div class="messageMessageListlist">${html}</div></div></section>`);
  return inspectRetryTranscript(page.getByRole('dialog'), { message, checkSince: since, timeoutMs: 850 });
}

browserTest('an older recalled row at the latest position covers the real legacy retry shape', async t => {
  assert.equal((await inspect(t, recalled(0))).status, 'clear');
  const timestampSibling = '<div data-index="0"><time>04/23</time><div class="messageMessageBoxmessageBox messageMessageBoxisFullRowCenterMessage">“对方” 撤回了一条消息</div></div>';
  assert.equal((await inspect(t, timestampSibling)).status, 'clear');
});

browserTest('a confirmed outgoing duplicate is reconciled while a same-text message of unknown direction is blocked', async t => {
  assert.equal((await inspect(t, row(0, `<span>${message}</span>`, '', 'data-message-direction="outgoing"') + recalled(1))).status, 'submitted');
  assert.equal((await inspect(t, row(0, `<span>${message}</span>`) + recalled(1))).status, 'uncertain');
});

browserTest('gaps, an unloaded conversation, and dates written by a participant cannot prove absence', async t => {
  for (const html of [recalled(2), row(0, '<span>消息正文</span>') + recalled(2), '', row(0, '<span>04/23</span>')]) {
    assert.equal((await inspect(t, html)).status, 'uncertain');
  }
});

browserTest('an explicit empty conversation is clear and a previously failed send needs no timestamp', async t => {
  assert.equal((await inspect(t, '<p>暂无聊天记录</p>')).status, 'clear');
  assert.equal((await inspect(t, row(0, '<span>早上好</span>'), null)).status, 'clear');
});
