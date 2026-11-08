import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKnowledgeChunkConfig } from '../app/lib/knowledge-chunking-config.ts';
import { splitConfiguredKnowledgeText } from '../app/lib/knowledge-library-chunks.ts';
test('configured methods preserve source and Unicode within hard bounds', () => {
 for (const method of ['recursive','paragraph','lines','fixed','delimiter']) {
 const text = '  😀第一句。\n第二行\n\n'.repeat(60)+'尾部  ';
 const config = normalizeKnowledgeChunkConfig({method, chunkSize:128, overlapPercent:0,linesPerChunk:3});
 const chunks=splitConfiguredKnowledgeText(text,config);
 assert.equal(chunks.map(c=>c.text).join(''),text);
 assert.ok(chunks.every(c=>Array.from(c.text).length<=128));
 }
});
test('strict validation and parent references',()=>{
 assert.throws(()=>normalizeKnowledgeChunkConfig({chunkSize:127}));
 assert.throws(()=>normalizeKnowledgeChunkConfig({overlapPercent:31}));
 const chunks=splitConfiguredKnowledgeText('😀'.repeat(1000),normalizeKnowledgeChunkConfig({strategy:'parent-child',parentChunkSize:256,childChunkSize:128}));
 for(const c of chunks.filter(c=>c.kind==='child')) assert.ok(chunks.find(p=>p.ordinal===c.parentOrdinal)?.text.includes(c.text));
});
test('headings isolate overlap and fenced heading text stays within section',()=>{
 const text='# One\n'+ 'a'.repeat(300)+'\n```\n# fake\n```\n# Two\n'+'b'.repeat(300);
 const chunks=splitConfiguredKnowledgeText(text,normalizeKnowledgeChunkConfig({chunkSize:128,method:'fixed'}));
 assert.ok(chunks.every(c=>!c.heading.includes('fake')));
 assert.ok(chunks.filter(c=>c.heading==='Two').every(c=>!c.text.includes('aaa')));
 assert.ok(chunks.at(-1)?.text.endsWith('bbb'));
});
test('capacity rejects instead of losing tail',()=>{
 assert.throws(()=>splitConfiguredKnowledgeText('x\n'.repeat(7000),normalizeKnowledgeChunkConfig({method:'lines',linesPerChunk:1,overlapPercent:0})),/容量/);
});
test('short line groups honor linesPerChunk even when the whole source fits the size cap',()=>{
 const text=Array.from({length:17},(_,i)=>`行${i+1}\n`).join('');
 const chunks=splitConfiguredKnowledgeText(text,normalizeKnowledgeChunkConfig({method:'lines',linesPerChunk:1,chunkSize:750,overlapPercent:0}));
 assert.equal(chunks.length,17);
 assert.equal(chunks.map(c=>c.text).join(''),text);
 for(const method of ['paragraph','delimiter'] as const){
  const short='首段\n\n尾段';
  const grouped=splitConfiguredKnowledgeText(short,normalizeKnowledgeChunkConfig({method,chunkSize:128,overlapPercent:0,delimiters:['\\n\\n']}));
  assert.equal(grouped.length,1,'paragraph and delimiter units still merge under the character cap');
  assert.equal(grouped[0].text,short);
 }
});
test('line overlap slides each window by its actual line count',()=>{
 for(const overlap of [10,30]) for(const prefix of ['x','中文😀']){
 const lines=Array.from({length:100},(_,i)=>`${prefix}${i}\n`);
 const chunks=splitConfiguredKnowledgeText(lines.join(''),normalizeKnowledgeChunkConfig({method:'lines',linesPerChunk:10,chunkSize:128,overlapPercent:overlap}));
 let start=0;
 for(const chunk of chunks){const expected=lines.slice(start,start+10).join('');assert.equal(chunk.text,expected);if(start+10>=100)break;start+=10-overlap/10;}
 assert.ok(chunks.at(-1)?.text.endsWith(lines[99]));
 }
});
test('long Unicode lines obey the cap and preserve exact tail',()=>{
 const text='😀中'.repeat(200)+'\n短行\n最后';
 const chunks=splitConfiguredKnowledgeText(text,normalizeKnowledgeChunkConfig({method:'lines',chunkSize:128,linesPerChunk:10,overlapPercent:0}));
 assert.equal(chunks.map(c=>c.text).join(''),text);
 assert.ok(chunks.every(c=>Array.from(c.text).length<=128));
});
test('million-character input keeps exact fixed tail and rejects excessive line groups', {timeout:10000},()=>{
 const text='中'.repeat(999999)+'尾';
 const chunks=splitConfiguredKnowledgeText(text,normalizeKnowledgeChunkConfig({method:'fixed',chunkSize:6000,overlapPercent:0}));
 assert.equal(chunks.map(c=>c.text).join(''),text);
 assert.equal(chunks.length,167);
 assert.throws(()=>splitConfiguredKnowledgeText('x\n'.repeat(500000),normalizeKnowledgeChunkConfig({method:'lines',linesPerChunk:1,overlapPercent:0})),/容量/);
});
test('recursive Chinese punctuation uses sentence boundaries without whitespace, preserves overlap and tail',()=>{
 for(const punctuation of ['。','？','！','；']){
 const first='甲'.repeat(100)+punctuation,text=first+'乙'.repeat(100)+punctuation+'尾巴';
 const split=(overlapPercent:number,method='recursive')=>splitConfiguredKnowledgeText(text,normalizeKnowledgeChunkConfig({method,chunkSize:128,overlapPercent}));
 assert.equal(split(0)[0].text,first);assert.equal(split(0).map(c=>c.text).join(''),text);
 assert.equal(split(10)[1].text.slice(0,10),first.slice(-10));assert.ok(split(10).at(-1)!.text.endsWith('尾巴'));assert.equal(split(0,'fixed')[0].text.length,128);
 }
 const decimal='甲'.repeat(100)+'3.14'+'乙'.repeat(100);assert.equal(splitConfiguredKnowledgeText(decimal,normalizeKnowledgeChunkConfig({chunkSize:128,overlapPercent:0}))[0].text.length,128);
});
