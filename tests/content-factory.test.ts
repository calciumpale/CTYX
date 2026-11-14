import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFactory, parseFactoryBrief, parseFactoryDocument } from '../app/lib/content-factory.ts';

const brief = { goal: 'leads', topic: '园区咖啡冷萃推广', audience: '园区上班族', tone: 'professional', channels: ['wechat', 'poster'], requirements: '冷萃19元。', brand: '澄光咖啡' } as const;
const copy = { channel: 'wechat', title: '园区午后冷萃', alternateTitle: '午休来杯冷萃', body: '园区午间来杯冷萃，19元。' };
const audience = { summary: '围绕园区上班族的午休场景。', tags: ['园区上班族', '午休'], nextStep: '人工核对文案，同时确认活动安排。' };
const board = { id: 'layout', name: '工作日冷萃', width: 1080, height: 1440, background: '#ffffff', layers: [{ id: 'title', kind: 'text', name: '主标题', text: '园区午后冷萃', assetUrl: '', x: 10, y: 14, width: 80, height: 35, fill: 'transparent', color: '#151515', fontSize: 80, radius: 0, weight: 'bold', align: 'left' }] };

test('uses the selected channels and retains the model copy when poster generation fails', async () => {
  const result = await generateFactory(parseFactoryBrief(brief), {}, async messages => {
    if (messages[0].content.includes('画板结构')) throw new Error('private provider payload');
    assert.match(messages[1].content, /园区上班族/);
    return JSON.stringify({ copy: [copy], audience });
  });
  assert.deepEqual(result.generated.copy, [copy]);
  assert.deepEqual(result.generated.audience, audience);
  assert.deepEqual(result.generated.posters, []);
  assert.ok(result.posterError);
  assert.doesNotMatch(result.posterError, /private provider payload/);
});

test('returns editable poster variants independently when regenerating posters', async () => {
  const result = await generateFactory(parseFactoryBrief(brief), { channel: 'poster' }, async messages => {
    assert.match(messages[0].content, /画板结构/);
    return JSON.stringify({ boards: [board, { ...board, id: 'other', background: '#aaffcc' }] });
  });
  assert.equal(result.generated.posters.length, 2);
  assert.deepEqual(result.generated.posters[0].layers, board.layers);
  assert.deepEqual(result.generated.copy, []);
  assert.equal(result.generated.audience, null);
});

test('rejects unsolicited channel output, missing channels and unsupported claims even when present in previous copy', async () => {
  for (const output of [
    [{ ...copy, channel: 'sms' }],
    [],
    [{ ...copy, body: '特价9元，100%保证满意。' }],
    [{ ...copy, body: '请访问 https://example.invalid' }],
  ]) {
    await assert.rejects(generateFactory(parseFactoryBrief(brief), { channel: 'wechat', previous: '旧稿：9元，100%保证满意。' }, async () => JSON.stringify({ copy: output, audience: null })), { status: 502 });
  }
  await assert.rejects(generateFactory(parseFactoryBrief(brief), { channel: 'sms' }, async () => ''), { status: 400 });
});

test('preserves valid poster variants when text returns malformed JSON', async () => {
  const result = await generateFactory(parseFactoryBrief(brief), {}, async messages => messages[0].content.includes('画板结构')
    ? JSON.stringify({ boards: [board, { ...board, id: 'other' }] }) : '模型没有按照 JSON 格式输出');
  assert.equal(result.generated.posters.length, 2);
  assert.deepEqual(result.generated.copy, []);
  assert.equal(result.generated.audience, null);
  assert.ok(result.copyError);
});

test('validates drafts, queue schedule status and rejects external poster assets', () => {
  const draft = { brief: { ...brief, topic: '', channels: [] }, generated: null, queue: [] };
  assert.deepEqual(parseFactoryDocument(draft), draft);
  const generated = { copy: [copy], posters: [], audience, generatedAt: '2026-11-14T10:20:30Z' };
  const item = { id: 'queue-1', channel: 'wechat', assetId: 'wechat', title: copy.title, body: copy.body, status: 'scheduled', scheduledAt: '2026-11-15T10:00' };
  assert.deepEqual(parseFactoryDocument({ brief, generated, queue: [item] }).queue, [item]);
  const edited = { ...generated, copy: [{ ...copy, title: '', body: '' }] };
  assert.deepEqual(parseFactoryDocument({ brief, generated: edited, queue: [] }).generated, edited);
  for (const scheduledAt of ['', '2026-02-30T10:00', '2026-11-15 10:00', '2026-11-15T25:00']) {
    assert.throws(() => parseFactoryDocument({ brief, generated, queue: [{ ...item, scheduledAt }] }), { status: 400 });
  }
  assert.throws(() => parseFactoryDocument({ brief, generated: { ...generated, posters: [{ ...board, layers: [{ ...board.layers[0], kind: 'image', assetUrl: '/api/marketing-materials/result?taskId=private-id&fileIndex=0' }] }] }, queue: [] }), { status: 400 });
});

test('accepts model preambles and localized channels for the auction brief and retries only the missing draft', async () => {
  const auction = parseFactoryBrief({
    ...brief,
    topic: '2026年第13次城投商铺公开拍租',
    audience: '潜在的承租户',
    brand: '海盐城投的商铺',
    requirements: '总共有12个铺，共5030平方米，业态不限',
    channels: ['wechat', 'xiaohongshu'],
  });
  const requests: string[][] = [];
  const result = await generateFactory(auction, {}, async messages => {
    const selected: string[] = JSON.parse(messages[1].content).生成渠道;
    requests.push(selected);
    if (requests.length === 1) {
      return '以下是活动文案：\n```json\n' + JSON.stringify({
        copy: [
          { channel: '公众号长文', title: '第13次商铺公开拍租', body: '共12间商铺，合计5,030㎡，业态不限。' },
          { channel: '小红书笔记', title: '海盐看铺', body: '本次有18间商铺，合计8999平方米。' },
        ],
      }) + '\n```';
    }
    return JSON.stringify({ copy: [{ channel: '小红书笔记', title: '海盐看铺', body: '海盐城投有12个铺，合计5030平方米，业态不限。' }] });
  });
  assert.deepEqual(requests, [['wechat', 'xiaohongshu'], ['xiaohongshu']]);
  assert.deepEqual(result.generated.copy.map(item => item.channel), ['wechat', 'xiaohongshu']);
  assert.equal(result.generated.copy[0].alternateTitle, '');
  assert.match(result.generated.copy[0].body, /5,030㎡/);
  assert.doesNotMatch(JSON.stringify(result), /8999|18间/);
  assert.equal(result.copyError, undefined);
});

test('returns successful channels when one channel gives malformed drafts twice', async () => {
  const selected = parseFactoryBrief({ ...brief, channels: ['wechat', 'xiaohongshu'] });
  let calls = 0;
  const response = await generateFactory(selected, {}, async () => {
    calls++;
    return calls === 1 ? JSON.stringify({ copy: [copy], audience: { tags: '错误格式' } }) : '文本，不是 JSON';
  });
  assert.equal(calls, 2);
  assert.deepEqual(response.generated.copy, [copy]);
  assert.equal(response.generated.audience, null);
  assert.match(response.copyError ?? '', /小红书笔记未生成/);
});
