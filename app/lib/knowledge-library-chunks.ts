import type { KnowledgeChunkDraft, KnowledgeChunkStrategy } from './knowledge-library-types.ts';
import { KNOWLEDGE_TEXT_LIMIT } from './knowledge-library-types.ts';

interface Section { text: string; heading: string; }
interface ChunkSize { min: number; target: number; max: number; overlap: number; }
const FLAT: ChunkSize = { min: 650, target: 750, max: 850, overlap: 80 };
const PARENT: ChunkSize = { min: 1200, target: 1350, max: 1500, overlap: 150 };
const CHILD: ChunkSize = { min: 300, target: 350, max: 400, overlap: 50 };

function sections(text: string): Section[] {
  const result: Section[] = [], hierarchy: Array<{ level: number; label: string }> = [];
  let start = 0, heading = '', fence = '';
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].trim();
    const delimiter = /^(`{3,}|~{3,})/.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = '';
      continue;
    }
    if (fence || line.length > 120) continue;
    const markdown = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);
    const plain = /^(?:第[一二三四五六七八九十百千万零〇两\d]+[章节篇部]|[一二三四五六七八九十百]+[、．.]\s*|【第\s*\d+\s*页】)/.test(line);
    if (!markdown && !plain) continue;
    const previous = text.slice(start, match.index).trim();
    if (previous) result.push({ text: previous, heading });
    const level = markdown ? markdown[1].length : 1, label = markdown ? markdown[2] : line;
    while (hierarchy.length && hierarchy[hierarchy.length - 1].level >= level) hierarchy.pop();
    hierarchy.push({ level, label }); heading = hierarchy.map(item => item.label).join(' / ');
    start = match.index;
  }
  const tail = text.slice(start).trim(); if (tail) result.push({ text: tail, heading });
  return result;
}

function safeOffset(text: string, offset: number): number {
  return offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset] || '') ? offset - 1 : offset;
}

function boundary(window: string, size: ChunkSize): number | undefined {
  // Prefer paragraph boundaries, then complete sentences, then line boundaries.
  for (const pattern of [/\r?\n[ \t]*\r?\n/g, /[。！？；;](?:[”’」』）)]+)?|[.!?](?:["'”’）)]+)?(?=\s|$)/g, /\r?\n/g]) {
    const candidates = [...window.matchAll(pattern)].map(match => match.index + match[0].length).filter(end => end >= size.min);
    if (candidates.length) return candidates.sort((a, b) => Math.abs(a - size.target) - Math.abs(b - size.target) || b - a)[0];
  }
  return undefined;
}

function passages(text: string, size: ChunkSize): string[] {
  const result: string[] = []; let start = 0;
  while (start < text.length) {
    if (text.length - start <= size.max) { const tail = text.slice(start).trim(); if (tail) result.push(tail); break; }
    const natural = boundary(text.slice(start, start + size.max), size);
    const end = safeOffset(text, start + (natural ?? size.max));
    const passage = text.slice(start, end).trim(); if (passage) result.push(passage);
    // Only forced cuts overlap. Natural boundaries keep whole sentences intact.
    start = natural === undefined ? safeOffset(text, end - size.overlap) : end;
  }
  return result;
}

/** Every chunk is a contiguous passage from the source, including its wording and punctuation. */
export function splitKnowledgeText(text: string, strategy: KnowledgeChunkStrategy): KnowledgeChunkDraft[] {
  if (typeof text !== 'string' || text.length > KNOWLEDGE_TEXT_LIMIT) throw new Error(`知识正文最多支持 ${KNOWLEDGE_TEXT_LIMIT.toLocaleString('en-US')} 字符，请拆分文档后导入。`);
  if (strategy !== 'flat' && strategy !== 'parent-child') throw new Error('不支持的知识分段方式。');
  const result: KnowledgeChunkDraft[] = [];
  const append = (kind: KnowledgeChunkDraft['kind'], content: string, heading: string, parentOrdinal: number | null) => {
    const ordinal = result.length + 1; result.push({ ordinal, parentOrdinal, kind, text: content, heading }); return ordinal;
  };
  for (const section of sections(text)) {
    for (const passage of passages(section.text, strategy === 'flat' ? FLAT : PARENT)) {
      const ordinal = append(strategy === 'flat' ? 'flat' : 'parent', passage, section.heading, null);
      if (strategy === 'parent-child') for (const child of passages(passage, CHILD)) append('child', child, section.heading, ordinal);
    }
  }
  return result;
}

const stopWords = new Set('的 了 和 与 及 或 是 在 有 我 我们 你 您 这个 那个 什么 怎么 如何 多少 请问 一下 可以 是否 吗 呢 吧 啊 对 相关 关于 一个 进行 需要'.split(' '));
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

/** Shared index/query tokens: precise model IDs and words first, CJK fallback bigrams last. */
export function tokenizeKnowledge(text: string, { unique = true }: { unique?: boolean } = {}): string[] {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/g, '-');
  const tokens: string[] = [], occurrences = new Set<string>(), models: Array<{ start: number; end: number }> = [];
  const add = (token: string, start: number, end: number) => {
    const key = `${start}:${end}:${token}`;
    if (!occurrences.has(key)) { occurrences.add(key); tokens.push(token); }
  };
  for (const match of normalized.matchAll(/[a-z0-9]+(?:[-_./][a-z0-9]+)*/g)) {
    if (!/[a-z]/.test(match[0]) || !/\d/.test(match[0])) continue;
    models.push({ start: match.index, end: match.index + match[0].length });
    add(match[0].replace(/[-_./]/g, ''), match.index, match.index + match[0].length);
  }
  for (const item of segmenter.segment(normalized)) {
    if (!item.isWordLike || stopWords.has(item.segment) || models.some(model => item.index >= model.start && item.index < model.end)) continue;
    for (const word of item.segment.matchAll(/[\p{L}\p{N}]+/gu)) {
      if (!stopWords.has(word[0]) && (word[0].length > 1 || /\p{Script=Han}/u.test(word[0]))) add(word[0], item.index + word.index, item.index + word.index + word[0].length);
    }
  }
  for (const match of normalized.matchAll(/\p{Script=Han}{2,}/gu)) {
    const characters = Array.from(match[0]); let start = match.index;
    for (let index = 0; index < characters.length - 1; index++) {
      const pair = characters[index] + characters[index + 1];
      if (!stopWords.has(pair) && !stopWords.has(characters[index]) && !stopWords.has(characters[index + 1])) add(pair, start, start + pair.length);
      start += characters[index].length;
    }
  }
  return unique ? [...new Set(tokens)] : tokens;
}
