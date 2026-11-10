import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMomentCopy } from '../app/lib/moments-generation.ts';
import type { MomentPlanInput } from '../app/lib/moments-types.ts';

const plan: MomentPlanInput = {
  productName: '桂花冷萃', productDetails: '轻盈桂花香，冷藏饮用。单杯19元。', style: 'playful',
  time: '08:30', enabled: true, includeImage: true,
};

test('Moments uses only product details and chosen style to generate text and a matching visual brief', async () => {
  const result = await generateMomentCopy(plan, async messages => {
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /朋友圈/);
    const product = JSON.parse(messages[1].content);
    assert.equal(product.productName, plan.productName);
    assert.equal(product.productDetails, plan.productDetails);
    assert.match(JSON.stringify(product), /有趣/);
    assert.doesNotMatch(messages[1].content, /08:30|sales-1/);
    return '```json\n{"text":"今天份的桂花香，冰一下再慢慢喝。单杯19元。","imagePrompt":"透明杯与桂花，清晨窗边的自然光"}\n```';
  });
  assert.equal(result.text, '今天份的桂花香，冰一下再慢慢喝。单杯19元。');
  assert.match(result.imagePrompt, /桂花冷萃/);
  assert.match(result.imagePrompt, /透明杯与桂花/);
});

test('text-only plans do not return a prompt that could create a paid image', async () => {
  const result = await generateMomentCopy({ ...plan, includeImage: false }, async () =>
    '{"text":"把桂花香留给今天的下午。","imagePrompt":"一杯冷萃"}');
  assert.equal(result.imagePrompt, '');
});

test('Moments rejects malformed output, markdown and fabricated prices, counts or absolute claims', async () => {
  for (const text of ['只有9.9元！', '只要9元。', '已经有三百家门店在用。', '全网最低。', '这里是**重点**', '[链接](https://example.invalid)']) {
    await assert.rejects(generateMomentCopy(plan, async () => JSON.stringify({ text, imagePrompt: '窗边清晨自然光' })), { status: 502 });
  }
  for (const response of ['模型未输出 JSON', '{"text":"一杯冷萃","imagePrompt":""}', '{"text":"一杯冷萃","imagePrompt":"窗边","debug":"private"}']) {
    await assert.rejects(generateMomentCopy(plan, async () => response), { status: 502 });
  }
});
