import { createHash } from 'node:crypto';
import { checkAbort } from './bridge-core.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

/** Reads rendered messages only. Unknown authors remain in the snapshot, never in the inbound feed. */
export async function readConversationTranscript(root, { senderAccountId, recipientId, conversationId, limit = 50, signal, timeoutMs = 10000, includeProof = false }) {
  const deadline = Date.now() + timeoutMs;
  let prior = '', snapshot = { loaded: false, reliable: false, covered: false, rows: [] }, stable = false;
  do {
    checkAbort(signal);
    snapshot = await root.evaluate((chat, identities) => {
      const visible = node => node instanceof HTMLElement && node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible';
      const panel = chat.querySelector('.messageMessageListwrapper, [data-e2e="message-list"]');
      if (!panel || !visible(panel)) return { loaded: false, reliable: false, covered: false, rows: [] };
      const list = panel.querySelector('.messageMessageListlist') || panel;
      if ([panel, list].some(node => node.getAttribute('aria-busy') === 'true') || [...list.querySelectorAll('[role="status"], [data-e2e="message-loading"]')].some(node => visible(node) && /加载/.test(node.innerText))) return { loaded: false, reliable: false, covered: false, rows: [] };
      const rowSelector = '.messageMessageBoxmessageBox, [data-e2e="message-item"], [data-e2e="chat-message"], [data-e2e="im-message"]';
      const avatarSelector = '[data-e2e="message-avatar"], [data-apm-action="个人页卡片"], .messageMessageBoxavatar';
      const excluded = `${avatarSelector}, button, [role="button"], time, .MessageBoxTimetimeLayout, [data-e2e="message-time"], [data-e2e="message-status"], script, style, svg`;
      const textFrom = parent => {
        const parts = [];
        const visit = node => {
          if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent); return; }
          if (!(node instanceof HTMLElement) || !visible(node) || node !== parent && node.matches(excluded)) return;
          if (node instanceof HTMLImageElement) { if (node.alt) parts.push(node.alt); return; }
          if (node.tagName === 'BR') { parts.push('\n'); return; }
          const block = node !== parent && ['block', 'flex', 'grid', 'list-item'].includes(getComputedStyle(node).display);
          if (block && parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n');
          for (const child of node.childNodes) visit(child);
          if (block) parts.push('\n');
        };
        visit(parent);
        return parts.join('').replace(/[\u200B\uFEFF]/g, '').replace(/\n{3,}/g, '\n\n').trim();
      };
      const elements = [...list.querySelectorAll(rowSelector)].filter(node => visible(node) && !node.parentElement?.closest(rowSelector));
      let reliable = true, covered = true;
      const rows = elements.map((row, order) => {
        const slot = row.closest('[data-index]');
        const index = slot && list.contains(slot) && /^\d+$/.test(slot.getAttribute('data-index')) ? Number(slot.getAttribute('data-index')) : null;
        const system = row.matches('.messageMessageBoxisFullRowCenterMessage, [data-message-type="system"]');
        const candidates = [...row.querySelectorAll('[data-e2e="message-text"], [data-e2e="msg-item-content"], [data-message-text]')].filter(visible);
        const body = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
        const content = body.length === 1 ? body[0] : row;
        const text = textFrom(content);
        const media = [...(content.matches('img, video, audio') ? [content] : []), ...content.querySelectorAll('img, video, audio')].filter(node => visible(node) && !node.closest(avatarSelector) && !(node instanceof HTMLImageElement && node.alt && node.width <= 40 && node.height <= 40));
        const unsupported = media.length > 0;
        // A single image has an observable author and presence, but no inferred
        // meaning. Keep that distinction instead of poisoning later text turns.
        const opaqueImage = media.length === 1 && media[0] instanceof HTMLImageElement && text === media[0].alt.trim();
        const readableText = opaqueImage ? '[图片消息，内容未识别]' : text;
        const indicators = [...row.querySelectorAll('[data-message-status], [data-status], [aria-label="发送失败"], [aria-label="发送中"], [title="发送失败"], [data-e2e="message-failed"], [data-e2e="message-pending"]')].filter(visible);
        const state = [row.getAttribute('data-message-status') || row.getAttribute('data-status') || '', ...indicators.map(node => node.getAttribute('data-message-status') || node.getAttribute('data-status') || node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-e2e') || '')].join(' ');
        const directions = new Set();
        if (row.matches('[data-message-direction="outgoing"], [data-sender="self"], [data-e2e="outgoing-message"]')) directions.add('outbound');
        if (row.matches('[data-message-direction="incoming"], [data-sender="other"], [data-e2e="incoming-message"]')) directions.add('inbound');
        const avatars = [...row.querySelectorAll(avatarSelector)].filter(visible);
        for (const avatar of avatars) {
          const link = avatar.matches('a[href]') ? avatar : avatar.querySelector('a[href]');
          if (!link || !visible(link)) continue;
          let url; try { url = new URL(link.getAttribute('href'), location.href); } catch { continue; }
          const match = /^\/user\/([a-zA-Z0-9_.-]{4,140})\/?$/.exec(url.pathname);
          if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(url.hostname) || url.port || !match) continue;
          if (match[1] === identities.senderAccountId || match[1] === 'self') directions.add('outbound');
          else if (match[1] === identities.recipientId) directions.add('inbound');
        }
        // The current one-to-one UI uses opposing avatar/bubble rows. Require
        // both the flex order and separated rendered positions, never a nickname.
        // Stack chat wraps this row in a block containing the timestamp.
        const contentRows = [...row.querySelectorAll('.messageMessageBoxcontentBox')].filter(visible);
        const layoutRow = contentRows.length === 1 ? contentRows[0] : row;
        const layoutBodies = body.length ? body : [...layoutRow.children].filter(node => visible(node) && !node.matches(excluded) && !node.querySelector(avatarSelector) && (textFrom(node) || opaqueImage && node.contains(media[0])));
        const placeholders = [...layoutRow.children].filter(node => node.matches('.messageMessageBoxstackLayoutHideAvatar'));
        const reserved = placeholders.length === 1 ? placeholders[0] : null;
        const reservedBox = reserved?.getBoundingClientRect();
        // Grouped Stack bubbles keep an empty 32px avatar slot in this row.
        // It proves layout only; hidden links and neighbouring rows prove nothing.
        const placeholder = avatars.length === 0 && contentRows.length === 1 && row.matches('.messageMessageBoxstackLayout') &&
          layoutRow.matches('.messageMessageBoxcontentBox.messageMessageBoxstackLayout') && reserved?.tagName === 'DIV' &&
          layoutBodies.length === 1 && layoutRow.contains(layoutBodies[0]) &&
          visible(reserved) && !reserved.children.length && !reserved.textContent.trim() &&
          Math.abs(reservedBox.width - 32) <= 1 && Math.abs(reservedBox.height - 32) <= 1 ? reserved : null;
        const layoutAvatars = placeholders.length ? placeholder ? [placeholder] : [] : avatars;
        if (!directions.size && layoutAvatars.length === 1 && layoutBodies.length === 1 && !system) {
          const style = getComputedStyle(layoutRow), box = layoutRow.getBoundingClientRect();
          const avatar = layoutAvatars[0].getBoundingClientRect(), bubble = layoutBodies[0].getBoundingClientRect();
          if (style.display.includes('flex') && avatar.width >= 20 && avatar.height >= 20 && bubble.width > 0 && box.width >= avatar.width + bubble.width) {
            if (style.flexDirection === 'row-reverse' && avatar.left >= bubble.right && avatar.right > box.left + box.width * .75) directions.add('outbound');
            if (style.flexDirection === 'row' && avatar.right <= bubble.left && avatar.left < box.left + box.width * .25) directions.add('inbound');
          }
        }
        const direction = directions.size === 1 ? [...directions][0] : 'unknown';
        const time = row.querySelector('time[datetime]') || slot?.querySelector('time[datetime]');
        const postedAt = time && visible(time) && Number.isFinite(Date.parse(time.getAttribute('datetime'))) ? new Date(time.getAttribute('datetime')).toISOString() : undefined;
        if (!system && (direction === 'unknown' || !readableText || unsupported && !opaqueImage || /pending|sending|failed|error|发送失败|发送中/.test(state))) reliable = false;
        return { nativeId: row.getAttribute('data-message-id') || row.getAttribute('data-msg-id') || '', direction, text: readableText, system, state, unsupported, ...(opaqueImage ? { contentType: 'image' } : {}),
          media: media.map(node => (node.currentSrc || node.getAttribute('src') || '').slice(0, 1000)), postedAt, index, order };
      });
      const indexed = rows.filter(row => row.index !== null);
      if (indexed.length) {
        const indices = [...new Set(indexed.map(row => row.index))].sort((a, b) => a - b);
        if (indexed.length !== rows.length || indices.some((value, index) => value !== index)) { reliable = false; covered = false; }
        rows.sort((a, b) => (b.index ?? -1) - (a.index ?? -1) || a.order - b.order);
      }
      const empty = !rows.length && /^(?:暂无消息|暂无聊天记录|还没有聊天记录)$/.test(list.innerText.trim());
      if (!rows.length && !empty) { reliable = false; covered = false; }
      return { loaded: rows.length > 0 || empty, reliable, covered, rows };
    }, { senderAccountId, recipientId });
    checkAbort(signal);
    const signature = JSON.stringify(snapshot);
    if (snapshot.loaded && signature === prior) { stable = true; break; }
    prior = signature;
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  const identity = `${senderAccountId}\n${recipientId}\n${conversationId}`;
  const occurrences = new Map(), usedIds = new Set(), rowOccurrences = new Map(), rowKeys = [], rowDigests = [], rowContentDigests = [], rowFieldDigests = [], messageKeys = {};
  let reliable = snapshot.reliable && stable;
  const messages = [];
  for (const row of snapshot.rows) {
    const rowBase = `${identity}\n${row.system ? 'system' : 'message'}\n${row.text}\n${row.media.join('\n')}`;
    const rowOccurrence = (rowOccurrences.get(rowBase) || 0) + 1; rowOccurrences.set(rowBase, rowOccurrence);
    const rowKey = row.nativeId ? `native:${digest(`${identity}\n${row.nativeId}`).slice(0, 40)}` : `visible:${digest(`${rowBase}\n${rowOccurrence}`).slice(0, 40)}`;
    rowKeys.push(rowKey);
    if (includeProof) {
      const { index: _index, order: _order, ...content } = row;
      rowDigests.push(digest(JSON.stringify([rowKey, content])));
      // Proof-only hashes: exclude synthetic occurrence keys, retain every payload field.
      rowContentDigests.push(digest(JSON.stringify(content)));
      rowFieldDigests.push(Object.fromEntries(['nativeId', 'direction', 'text', 'postedAt', 'contentType', 'state', 'media', 'system', 'unsupported']
        .map(field => [field, digest(JSON.stringify(content[field] ?? null))])));
    }
    if (row.system || row.direction === 'unknown' || !row.text || row.unsupported && row.contentType !== 'image' || /pending|sending|failed|error|发送失败|发送中/.test(row.state)) continue;
    const base = `${identity}\n${row.direction}\n${row.text}\n${row.postedAt || ''}${row.contentType === 'image' ? '\n' + row.media.join('\n') : ''}`;
    const occurrence = (occurrences.get(base) || 0) + 1; occurrences.set(base, occurrence);
    const id = row.nativeId ? `native:${digest(`${identity}\n${row.nativeId}`).slice(0, 40)}` : `dom:${digest(`${base}\n${occurrence}`).slice(0, 40)}`;
    if (usedIds.has(id)) { reliable = false; continue; } usedIds.add(id);
    messageKeys[id] = rowKey;
    messages.push({ id, direction: row.direction, text: row.text, ...(row.contentType ? { contentType: row.contentType } : {}), ...(row.postedAt ? { postedAt: row.postedAt } : {}) });
  }
  const maximum = Math.max(1, Math.min(100, Number(limit) || 50));
  if (messages.length > maximum) reliable = false;
  const covered = stable && snapshot.covered && new Set(rowKeys).size === rowKeys.length;
  return { senderAccountId, recipientId, observedAt: new Date().toISOString(),
    snapshotId: `snapshot:${digest(`${identity}\n${JSON.stringify(snapshot)}`).slice(0, 48)}`,
    messages: messages.slice(-maximum), reliable, covered,
    ...(includeProof ? { proof: { covered, rowKeys, rowDigests, rowContentDigests, rowFieldDigests, messageKeys } } : {}) };
}
