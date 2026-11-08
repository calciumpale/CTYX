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

import { normalizeKnowledgeChunkConfig, type KnowledgeChunkConfig } from './knowledge-chunking-config.ts';

/** Configured sizes count Unicode code points; ingress and aggregate limits count UTF-16. */
export function splitConfiguredKnowledgeText(text: string, config: KnowledgeChunkConfig): KnowledgeChunkDraft[] {
 if(typeof text!=='string'||text.length>KNOWLEDGE_TEXT_LIMIT) throw new Error('知识正文超出容量限制。');
 const c=normalizeKnowledgeChunkConfig(config), result: KnowledgeChunkDraft[]=[];
 let total=0;
 const append=(content:string,heading:string,kind:KnowledgeChunkDraft['kind'],parentOrdinal:number|null)=>{
 total+=content.length;
 if(result.length>=6000||total>3000000) throw new Error('切块结果超出容量限制，请增大块大小或降低重叠。');
 const ordinal=result.length+1; result.push({ordinal,parentOrdinal,kind,text:content,heading});return ordinal;
 };
 function split(source:string,size:number,overlap:number):string[]{
 // Even without overlap or character-forced cuts, each group consumes at most N lines.
 // Reject this lower bound before allocating a code-point array or line boundary table.
 if(c.method==='lines'){
 let lineCount=source.endsWith('\n')?0:1;
 for(let i=0;i<source.length;i++)if(source.charCodeAt(i)===10)lineCount++;
 if(Math.ceil(lineCount/c.linesPerChunk)>6000)throw new Error('切块结果超出容量限制，请增大块大小或降低重叠。');
 }
 const chars=Array.from(source), ends:number[]=[];let offset=0;
 let mappedOffset=0, mappedPoints=0;
 const pointAt=(target:number)=>{while(mappedOffset<target){mappedOffset+=source.codePointAt(mappedOffset)!>0xffff?2:1;mappedPoints++;}return mappedPoints;};
 const units=c.method==='lines'?source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean):null;
 if(units){for(let i=0;i<units.length;i++){offset+=Array.from(units[i]).length;ends.push(offset);}}
 else if(c.method!=='fixed'){
 const pattern=c.method==='paragraph'?/\r?\n[ \t]*\r?\n/g:c.method==='recursive'?/\r?\n[ \t]*\r?\n|[。！？；]|[;.!?](?:\s|$)|\n/g:null;
 if(pattern) for(const m of source.matchAll(pattern)) ends.push(pointAt(m.index+m[0].length));
 else {let at=0; for(const ch of chars){at++;offset+=ch.length; if(c.delimiters.some(d=>source.startsWith(d,offset-d.length))) ends.push(at);}}
 }
 const output:string[]=[];let start=0;
 const firstAfter=(value:number)=>{let low=0,high=ends.length;while(low<high){const mid=(low+high)>>>1;if(ends[mid]<=value)low=mid+1;else high=mid;}return low;};
 while(start<chars.length){let end=Math.min(start+size,chars.length);
 if((c.method==='lines'||end<chars.length) && c.method!=='fixed'){const first=firstAfter(start),last=firstAfter(end)-1;if(last>=first) end=ends[c.method==='lines'?Math.min(first+c.linesPerChunk-1,last):last];}
 output.push(chars.slice(start,end).join(''));if(output.length>6000) throw new Error('切块结果超出容量限制，请增大块大小或降低重叠。');if(end===chars.length) break;
 let next=end-Math.floor((end-start)*overlap/100);
 if(c.method==='lines'&&overlap){const slice=chars.slice(start,end);const lineStarts=[0];slice.forEach((ch,i)=>{if(ch==='\n'&&i+1<slice.length)lineStarts.push(i+1);});const count=Math.floor(lineStarts.length*overlap/100);next=count?start+lineStarts[lineStarts.length-count]:end;}
 start=Math.max(start+1,next);
 }return output;
 }
 // Reuse heading/fence recognition while preserving every source character.
 const recognized=sections(text);let cursor=0;
 for(let i=0;i<recognized.length;i++){
 const section=recognized[i], found=text.indexOf(section.text,cursor);
 const next=i+1<recognized.length?text.indexOf(recognized[i+1].text,found+section.text.length):text.length;
 const source=text.slice(cursor,next);cursor=next;
 for(const passage of split(source,c.strategy==='flat'?c.chunkSize:c.parentChunkSize,c.overlapPercent)){
 const ordinal=append(passage,section.heading,c.strategy==='flat'?'flat':'parent',null);
 if(c.strategy==='parent-child')for(const child of split(passage,c.childChunkSize,c.childOverlapPercent))append(child,section.heading,'child',ordinal);
 }
 }
 return result;
}
