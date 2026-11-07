import assert from 'node:assert/strict';
import test from 'node:test';
import { splitKnowledgeText, tokenizeKnowledge } from '../app/lib/knowledge-library-chunks.ts';

test('flat chunks retain headings, Chinese sentences and the original evidence', () => {
  const first = Array.from({ length: 60 }, (_, i) => `第${i + 1}项服务：设备支持远程维护，实际价格以报价单为准。`).join('\n');
  const source = `# 产品资料\n## 服务范围\n${first}\n\n## 限制条件\n本产品不支持室外使用。`;
  const chunks = splitKnowledgeText(source, 'flat');
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(chunk => chunk.kind === 'flat' && chunk.parentOrdinal === null && source.includes(chunk.text)));
  assert.ok(chunks.every(chunk => chunk.text.length <= 850));
  assert.ok(chunks.some(chunk => chunk.text.length >= 650));
  assert.ok(chunks.some(chunk => chunk.heading === '产品资料 / 服务范围'));
  assert.equal(chunks.at(-1)?.heading, '产品资料 / 限制条件');
  for (let i = 1; i <= 60; i++) assert.ok(chunks.some(chunk => chunk.text.includes(`第${i}项服务：设备支持远程维护，实际价格以报价单为准。`)));
  assert.deepEqual(chunks.map(chunk => chunk.ordinal), chunks.map((_, index) => index + 1));
});

test('oversized unbroken text uses overlap without cutting Unicode characters or omitting evidence', () => {
  const source = Array.from({ length: 1800 }, (_, i) => `${i}😀`).join('');
  const chunks = splitKnowledgeText(source, 'flat');
  assert.ok(chunks.length > 2);
  let end = 0;
  for (const chunk of chunks) {
    assert.ok(source.includes(chunk.text));
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text));
    const start = source.indexOf(chunk.text);
    assert.ok(start <= end); end = Math.max(end, start + chunk.text.length);
  }
  assert.equal(end, source.length);
  assert.ok(source.indexOf(chunks[1].text) < chunks[0].text.length);
});

test('parent-child chunks point to bounded original parent passages and preserve section locators', () => {
  const source = `第一章 使用说明\n${Array.from({ length: 120 }, (_, i) => `步骤${i + 1}：开机后先核对设备型号，再进行功能设置，确保资料与设备一致。`).join('\n')}\n\n第二章 维护\n请每月进行一次维护。`;
  const chunks = splitKnowledgeText(source, 'parent-child');
  const parents = chunks.filter(chunk => chunk.kind === 'parent');
  assert.ok(parents.length > 2); assert.ok(parents.some(chunk => chunk.text.length >= 1200));
  assert.ok(parents.every(chunk => chunk.text.length <= 1500 && chunk.parentOrdinal === null));
  const children = chunks.filter(chunk => chunk.kind === 'child');
  assert.ok(children.some(chunk => chunk.text.length >= 300));
  for (const child of children) {
    const parent = parents.find(candidate => candidate.ordinal === child.parentOrdinal);
    assert.ok(parent); assert.ok(parent.text.includes(child.text)); assert.equal(child.heading, parent.heading);
    assert.ok(child.text.length <= 400);
  }
  assert.equal(new Set(chunks.map(chunk => chunk.ordinal)).size, chunks.length);
  assert.ok(chunks.every(chunk => source.includes(chunk.text)));
});

test('page markers locate PDF evidence and code fences do not invent headings', () => {
  const source = '【第 1 页】\n产品 AB-12 的说明。\n```md\n# 这行是代码\n```\n\n【第 2 页】\n保修期为一年。';
  const chunks = splitKnowledgeText(source, 'flat');
  assert.equal(chunks.length, 2); assert.equal(chunks[0].heading, '【第 1 页】'); assert.equal(chunks[1].heading, '【第 2 页】');
  assert.ok(chunks[0].text.includes('# 这行是代码'));
  assert.deepEqual(splitKnowledgeText(' \n ', 'flat'), []);
  assert.throws(() => splitKnowledgeText('字'.repeat(1_000_001), 'flat'), /1,000,000|1000000/);
});

test('document and query tokenization normalize model IDs and retain Chinese fallback phrases', () => {
  const tokens = tokenizeKnowledge('请问 ＡＢ－１２ 的价格是多少？星瀚灵犀传感模组支持离线部署。');
  assert.ok(tokens.includes('ab12')); assert.ok(tokens.includes('价格')); assert.ok(tokens.includes('瀚灵'));
  assert.ok(!tokens.includes('请问')); assert.ok(!tokens.includes('多少')); assert.ok(!tokens.includes('的'));
  assert.ok(!tokens.includes('ab')); assert.ok(!tokens.includes('12'));
  assert.equal(tokens[0], 'ab12');
  assert.deepEqual(tokenizeKnowledge('AB_12'), tokenizeKnowledge('ab12'));
  assert.equal(new Set(tokens).size, tokens.length);
  assert.deepEqual(tokenizeKnowledge(' \n 😀 ：？'), []);
});

test('corpus tokens preserve actual term frequency without duplicating overlapping word and bigram evidence', () => {
  const text = '价格价格，价格。AB-12 AB_12';
  const corpus = tokenizeKnowledge(text, { unique: false });
  assert.equal(corpus.filter(token => token === '价格').length, 3);
  assert.equal(corpus.filter(token => token === 'ab12').length, 2);
  assert.deepEqual(tokenizeKnowledge(text), [...new Set(corpus)]);
  assert.deepEqual(tokenizeKnowledge('价格', { unique: false }), ['价格']);
});


test('million-character documents retain their tail in both split strategies',()=>{
 const source='资料正文。'.repeat(199_996)+'尾部唯一标记。';
 assert.ok(source.length>999_000&&source.length<=1_000_000);
 for(const strategy of ['flat','parent-child'] as const){
  const chunks=splitKnowledgeText(source,strategy);
  assert.ok(chunks.length>400);assert.ok(chunks.length<=6000);
  assert.ok(chunks.some(c=>c.text.endsWith('尾部唯一标记。')));
  for(const child of chunks.filter(c=>c.kind==='child'))assert.ok(chunks.find(c=>c.ordinal===child.parentOrdinal)?.text.includes(child.text));
 }
});


test('upload JSON accepts the full UTF-8 and escaped knowledge capacity and keeps a bounded request size',async()=>{
 const {readMeetingBody}=await import('../app/lib/meeting-import-validation.ts');
 const {KNOWLEDGE_REQUEST_LIMIT,KNOWLEDGE_TEXT_LIMIT}=await import('../app/lib/knowledge-library-types.ts');
 for(const value of ['汉'.repeat(KNOWLEDGE_TEXT_LIMIT),'\\'.repeat(KNOWLEDGE_TEXT_LIMIT)]){
  const request=new Request('https://workbench.test/api/knowledge-library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'upload',text:value})});
  const input=await readMeetingBody(request,KNOWLEDGE_REQUEST_LIMIT);assert.equal(input.text,value);
 }
 const tooBig=new Request('https://workbench.test/api/knowledge-library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'x'.repeat(KNOWLEDGE_REQUEST_LIMIT)})});
 await assert.rejects(readMeetingBody(tooBig,KNOWLEDGE_REQUEST_LIMIT),{status:413});
});
