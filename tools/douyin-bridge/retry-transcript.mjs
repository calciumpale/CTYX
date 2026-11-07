import { checkAbort } from './bridge-core.mjs';

const unreadable = { status: 'uncertain', error: '暂时未能读到上次发送时段的抖音会话，未重发。请稍后在工作台再试。' };
const duplicate = { status: 'uncertain', error: '会话中已出现同样的文案，无法确认发送方或状态，已停止重试以免重复。' };
const submitted = { status: 'submitted', evidence: '在已核对的抖音私聊中查到本人发出的同文消息，本次未再次提交。' };
const clear = { status: 'clear' };

export async function inspectRetryTranscript(root, { message, checkSince, signal, timeoutMs = 10000 }) {
  const cutoff = checkSince ? Date.parse(checkSince) : null;
  if (checkSince && !Number.isFinite(cutoff)) return unreadable;
  const deadline = Date.now() + timeoutMs;
  let priorCoverage = '';
  do {
    checkAbort(signal);
    const snapshot = await root.evaluate((chat, { message, cutoff }) => {
      const visible = node => node instanceof HTMLElement && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible';
      const panel = chat.querySelector('.messageMessageListwrapper, [data-e2e="message-list"]');
      if (!panel || !visible(panel)) return {};
      const list = panel.querySelector('.messageMessageListlist') || panel;
      if ([panel, list].some(node => node.getAttribute('aria-busy') === 'true') ||
          [...list.querySelectorAll('[role="status"], [data-e2e="message-loading"]')].some(node => visible(node) && /加载/.test(node.innerText))) return {};

      const rowSelector = '.messageMessageBoxmessageBox, [data-e2e="message-item"], [data-e2e="chat-message"], [data-e2e="im-message"]';
      const rows = [...list.querySelectorAll(rowSelector)].filter(visible);
      const failedSelector = '[data-message-status="failed"], [data-status="failed"], [aria-label="发送失败"], [title="发送失败"]';
      const pendingSelector = '[data-message-status="pending"], [data-status="pending"], [aria-label="发送中"]';
      const outboundSelector = '[data-message-direction="outgoing"], [data-sender="self"], [data-e2e="outgoing-message"]';
      const indicated = (row, selector) => row.matches(selector) || [...row.querySelectorAll(selector)].some(visible);
      const exact = node => visible(node) && node.innerText.trim() === message.trim();
      let sameText = false;
      for (const row of rows) {
        if (indicated(row, failedSelector) || ![row, ...row.querySelectorAll('div, span, p')].some(exact)) continue;
        if (indicated(row, outboundSelector) && !indicated(row, pendingSelector)) return { outbound: true };
        sameText = true;
      }
      if (sameText) return { duplicate: true };
      if (cutoff === null) return { covered: 'confirmed-preflight-failure' };
      if (!rows.length && /^(?:暂无消息|暂无聊天记录|还没有聊天记录)$/.test(list.innerText.trim())) return { covered: 'empty' };

      // Douyin virtualizes messages with index 0 at the latest end of the conversation.
      const indexed = new Map();
      for (const row of rows) {
        const slot = row.closest('[data-index]');
        if (slot && list.contains(slot) && /^\d+$/.test(slot.getAttribute('data-index'))) indexed.set(Number(slot.getAttribute('data-index')), slot);
      }
      const now = new Date();
      const endOfLabel = (raw) => {
        const label = raw.trim().replaceAll('：', ':');
        if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(label) && /(?:Z|[+-]\d\d:\d\d)$/.test(label)) return Date.parse(label);
        const calendar = /^(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?$/.exec(label);
        const clock = /^(?:(今天|昨天)\s*)?(\d{1,2}):(\d{2})$/.exec(label);
        if (!calendar && !clock) return NaN;
        const date = new Date(now);
        if (calendar) {
          const [, year, month, day] = calendar;
          date.setHours(0, 0, 0, 0);
          date.setFullYear(year ? Number(year) : now.getFullYear(), Number(month) - 1, Number(day));
          if (!year && date.getTime() > now.getTime()) date.setFullYear(date.getFullYear() - 1);
          if (date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return NaN;
        } else if (clock[1] === '昨天') date.setDate(date.getDate() - 1);
        const hours = Number(calendar ? calendar[4] ?? 23 : clock[2]);
        const minutes = Number(calendar ? calendar[5] ?? 59 : clock[3]);
        if (hours > 23 || minutes > 59) return NaN;
        return date.setHours(hours, minutes, 59, 999);
      };
      for (let index = 0; indexed.has(index); index++) {
        const slot = indexed.get(index);
        // Only provider time markers and centered system rows can anchor coverage.
        // A message written by a participant can itself contain a date.
        const timeLabels = [...slot.querySelectorAll('time[datetime]')].filter(visible).map(node => node.dateTime);
        const system = slot.querySelector('.messageMessageBoxisFullRowCenterMessage');
        if (system && visible(system)) {
          timeLabels.push(...[system, ...system.querySelectorAll('span, div, p, time')].filter(visible).map(node => node.innerText));
          if (slot.querySelectorAll(rowSelector).length === 1) {
            const lines = slot.innerText.split(/\r?\n/);
            timeLabels.push(...lines);
            const recall = /^(.+?)\s*["“][^"\r\n”]+["”]\s*撤回了一条消息$/.exec(slot.innerText.trim());
            if (recall) timeLabels.push(recall[1]);
          }
        }
        for (const label of timeLabels) {
          const latestPossible = endOfLabel(label);
          if (Number.isFinite(latestPossible) && latestPossible < cutoff) return { covered: index + ':' + latestPossible };
        }
      }
      return {};
    }, { message, cutoff });
    checkAbort(signal);
    if (snapshot.outbound) return submitted;
    if (snapshot.duplicate) return duplicate;
    if (cutoff === null && snapshot.covered) return clear;
    if (snapshot.covered && snapshot.covered === priorCoverage) return clear;
    priorCoverage = snapshot.covered || '';
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return unreadable;
}
