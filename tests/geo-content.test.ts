import { buildGeoStructuredData } from '../app/lib/geo-structured-data.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {checkGeoQuality, generateGeoArticle, geoPublicUrl, parseGeoBrief, parseGeoDocument} from '../app/lib/geo-content.ts';
import {emptyGeoDocument} from '../app/lib/geo-types.ts';

const brief = {
  brand: '八克咖啡', topic: '冷萃咖啡怎么保存', audience: '家庭咖啡爱好者', question: '冷萃咖啡应该怎么保存？',
  sources: [{title: '产品包装说明', url: 'https://coffee.example.com/guide?view=1', excerpt: '冷萃咖啡开封后应冷藏保存。'}],
};
const article = {
  title: '冷萃咖啡开封后怎么保存',
  summary: '根据产品包装说明，冷萃咖啡在开封后应冷藏保存。',
  markdown: '## 开封后的保存方式\n\n根据产品包装说明，冷萃咖啡开封后应冷藏保存。[1]\n\n购买其他产品时请查看对应包装上的保存说明。',
  faq: [{question: '开封后需要冷藏吗？', answer: '这款冷萃咖啡开封后应冷藏保存。[1]'}],
};

test('drafts may be empty, while source fields only accept syntactically public HTTPS addresses', () => {
  assert.deepEqual(parseGeoDocument(emptyGeoDocument()), emptyGeoDocument());
  assert.deepEqual(parseGeoBrief(brief), brief);
  for (const url of ['http://example.com', 'https://localhost', 'https://10.0.0.1', 'https://[::1]', 'https://user@example.com', 'https://app.local', 'https://example.com:3000', 'https://example.com\\@app.local']) {
    assert.throws(() => geoPublicUrl(url), {status: 400});
  }
  assert.equal(geoPublicUrl('https://example.com/guide#source'), 'https://example.com/guide#source');
  assert.throws(() => parseGeoBrief({...brief, sources: Array(9).fill(brief.sources[0])}), {status: 400});
  assert.throws(() => parseGeoBrief({...brief, topic: '主题'.repeat(61)}), {status: 400});
});

test('article parser excludes executable markup and embedded URLs from user-editable text', () => {
  for (const markdown of ['<script>alert(1)</script>', '[查看](javascript:alert(1))', '![图](https://external.example.com/i.png)', '[来源]: https://external.example.com', '详情见 https://external.example.com']) {
    assert.throws(() => parseGeoDocument({brief, article: {...article, markdown}}), {status: 400});
  }
  assert.deepEqual(parseGeoDocument({brief, article}), {brief, article});
});

test('quality gate requires usable source evidence and valid source references in the body', () => {
  assert.equal(checkGeoQuality(emptyGeoDocument()).ready, false);
  assert.equal(checkGeoQuality(emptyGeoDocument()).score, 0);
  assert.equal(checkGeoQuality({brief, article}).ready, true);
  assert.equal(checkGeoQuality({brief, article}).score, 100);
  const internal = {...brief, sources: [{...brief.sources[0], url: ''}]};
  assert.equal(checkGeoQuality({brief: internal, article}).ready, true);
  const missing = {...article, markdown: article.markdown.replace('[1]', '')};
  assert.equal(checkGeoQuality({brief, article: missing}).ready, false);
  for (const invalid of ['[2]', '[0]', '[01]', '[1,2]', '[１]']) {
    const body = {...article, markdown: article.markdown + ' ' + invalid};
    assert.equal(checkGeoQuality({brief, article: body}).ready, false);
  }
  const noEvidence = {...brief, sources: [{...brief.sources[0], excerpt: ''}]};
  assert.equal(checkGeoQuality({brief: noEvidence, article}).ready, false);
  const invalidFaq = {...article, faq: [{question: '问题', answer: '请核实。[2]'}]};
  assert.equal(checkGeoQuality({brief, article: invalidFaq}).ready, false);
  const noHeading = {...article, markdown: article.markdown.replace('## ', '')};
  assert.equal(checkGeoQuality({brief, article: noHeading}).ready, true);
  assert.ok(checkGeoQuality({brief, article: noHeading}).score < 100);
});

test('generation sends explicitly numbered evidence and rejects model citations outside the allowed list', async () => {
  const output = await generateGeoArticle(brief, async messages => {
    const context = JSON.parse(messages[1].content);
    assert.deepEqual(context.sources, [{number: 1, title: brief.sources[0].title, excerpt: brief.sources[0].excerpt}]);
    assert.ok(!messages[1].content.includes(brief.sources[0].url));
    assert.match(messages[0].content, /\[1\]/);
    return '\x60\x60\x60json\n' + JSON.stringify(article) + '\n\x60\x60\x60';
  });
  assert.deepEqual(output, article);
  await assert.rejects(generateGeoArticle(brief, async () => JSON.stringify({...article, markdown: '正文中的引用不正确。[5]'})), {status: 502});
  await assert.rejects(generateGeoArticle({...brief, sources: []}, async () => assert.fail('未提供证据时不应调用模型')), {status: 400});
});


test('structured GEO export reflects only the article, public citations and complete visible FAQ text', () => {
  const source = { title: '正式说明', url: 'https://example.com/guide', excerpt: '已提供内容' };
  const document = {
    brief: { brand: '品牌', topic: '主题', audience: '', question: '', sources: [source, source] },
    article: { title: '真实标题', summary: '真实摘要', markdown: '正文内容 [1]', faq: [{ question: '一个问题', answer: '回答' }, { question: '缺失回答', answer: '' }] },
  };
  assert.deepEqual(buildGeoStructuredData(document, { url: 'https://example.com/article', channel: '官网', recordedAt: '2026-11-15T03:00:00.000Z' }), {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Article', url: 'https://example.com/article', headline: '真实标题', articleBody: '正文内容 [1]', description: '真实摘要', citation: [source.url] },
      { '@type': 'FAQPage', url: 'https://example.com/article', mainEntity: [{ '@type': 'Question', name: '一个问题', acceptedAnswer: { '@type': 'Answer', text: '回答' } }] },
    ],
  });
  assert.equal(buildGeoStructuredData({ ...document, article: { ...document.article, markdown: ' ' } }), null);
});
