import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyStudioCopy } from '../app/lib/creative-studio-types.ts';
import type { StudioBoard, StudioDocument, StudioLayer } from '../app/lib/creative-studio-types.ts';
import { generateStudio } from '../app/lib/creative-studio-model.ts';
import { parseStudioDocument, studioAssetUrl } from '../app/lib/creative-studio-validation.ts';

const text: StudioLayer = {
  id: 'headline', kind: 'text', name: '标题', text: '手冲冷萃', assetUrl: '',
  x: 10, y: 12, width: 80, height: 30, fill: 'transparent', color: '#121212',
  fontSize: 48, radius: 0, weight: 'bold', align: 'left',
};
const assetUrl = '/api/marketing-materials/result?taskId=private-material&fileIndex=0';
const image: StudioLayer = { ...text, id: 'image', kind: 'image', name: '配图', text: '', assetUrl };
const board: StudioBoard = { id: 'cover', name: '封面', width: 1080, height: 1440, background: '#ffffff', layers: [text, image] };
const document: StudioDocument = {
  title: '冷萃推广', kind: 'poster', brief: '来自巴拿马的冷萃，售价19元，瓶装。', audience: '咖啡爱好者',
  channel: '小红书', style: '自然', copy: emptyStudioCopy(), boards: [board],
};

test('creative copy returns grounded plain-text fields and a typed storyboard', async () => {
  const copy = {
    title: '午后冷萃', caption: '午后的冷萃，19元一瓶。', script: '让镜头停在瓶身。',
    coverPrompt: '暖色桌面上的冷萃瓶', shots: [{ visual: '冷萃瓶近景', voiceover: '今天喝一瓶冷萃。', seconds: 5 }],
  };
  const accepted = await generateStudio('copy', document, {}, async messages => {
    assert.match(messages[0].content, /JSON/);
    assert.match(messages[1].content, /售价19元/);
    assert.doesNotMatch(messages[1].content, /private-material/);
    return JSON.stringify({ copy });
  });
  assert.deepEqual(accepted, { copy });
  for (const caption of ['现价9元', '销量5000单', 'https://example.invalid/', '<a href="https://example.invalid/">点击</a>']) {
    await assert.rejects(generateStudio('copy', document, {}, async () => JSON.stringify({ copy: { ...copy, caption } })), { status: 502 });
  }
});

test('copy revisions receive the current shots and preserve unrequested fields', async () => {
  const copy = {
    title: '已有标题', caption: '已有推广文案', script: '会员价88元。', coverPrompt: '暖色桌面',
    shots: [
      { visual: '把杯子放在窗边', voiceover: '销量300单。', seconds: 5 },
      { visual: '冷萃瓶近景', voiceover: '等冰块慢慢融化。', seconds: 8 },
    ],
  };
  const existing = { ...document, copy };
  const instruction = '仅修改发布文案的开头';
  const caption = '午后打开一瓶冷萃。';
  const result = await generateStudio('copy', existing, { instruction }, async messages => {
    const context = JSON.parse(messages[1].content);
    assert.equal(context.修改说明, instruction);
    assert.deepEqual(context.当前稿件, copy);
    assert.doesNotMatch(messages[1].content, /private-material/);
    return JSON.stringify({ copy: { caption } });
  });
  assert.deepEqual(result.copy, { ...copy, caption });

  for (const unsupported of ['限时优惠9元', '会员价88元。', '销量300单。']) {
    await assert.rejects(generateStudio('copy', existing, { instruction }, async () =>
      JSON.stringify({ copy: { caption: unsupported } })), { status: 502 });
  }
  const shots = [{ ...copy.shots[0], visual: '镜头靠近窗边的杯子' }, copy.shots[1]];
  const changedShot = await generateStudio('copy', existing, { instruction: '只改第一个分镜的画面' }, async () =>
    JSON.stringify({ copy: { shots } }));
  assert.deepEqual(changedShot.copy, { ...copy, shots });
});

test('design validates artboard count, finite geometry, typed fields and source URLs', async () => {
  const candidate = { ...board, layers: [text] };
  const boards = [candidate, { ...candidate, id: 'alternate' }];
  const first = (await generateStudio('design', document, {}, async () => JSON.stringify({ boards }))).boards!;
  const second = (await generateStudio('design', document, {}, async () => JSON.stringify({ boards }))).boards!;
  assert.equal(new Set([...first, ...second, board].map(item => item.id)).size, 5);
  assert.deepEqual(first.map(item => item.layers), boards.map(item => item.layers));
  for (const bad of [
    [candidate],
    [candidate, candidate],
    [candidate, { ...candidate, id: 'alternate', background: 'url(https://example.invalid)' }],
    [candidate, { ...candidate, id: 'alternate', layers: [image] }],
    [candidate, { ...candidate, id: 'alternate', layers: [{ ...text, x: 250 }] }],
    [candidate, { ...candidate, id: 'alternate', layers: [{ ...text, javascript: 'alert(1)' }] }],
  ]) {
    await assert.rejects(generateStudio('design', document, {}, async () => JSON.stringify({ boards: bad })), { status: 502 });
  }
});

test('AI revise preserves selected identifiers, sibling layers, and private assets', async () => {
  const revised = { ...board, id: 'arbitrary-id', layers: [{ ...text, text: '一瓶手冲冷萃' }, { ...image, assetUrl: '' }] };
  const result = await generateStudio('revise', document, { selection: { boardId: board.id, layerId: text.id }, instruction: '换一个标题' }, async messages => {
    assert.doesNotMatch(messages[1].content, /private-material/);
    return JSON.stringify({ boards: [revised] });
  });
  assert.deepEqual(result.boards, [{ ...board, layers: [{ ...text, text: '一瓶手冲冷萃' }, image] }]);
  const whole = await generateStudio('revise', document, { selection: { boardId: board.id }, instruction: '调整整体' }, async () => JSON.stringify({ boards: [revised] }));
  assert.equal(whole.boards?.[0].id, board.id);
  assert.equal(whole.boards?.[0].layers[1].assetUrl, assetUrl);
  await assert.rejects(generateStudio('revise', document, { instruction: '不存在', selection: { boardId: 'invalid' } }, async () => { throw new Error('unexpected model call'); }), { status: 400 });
});

test('private assets accept only existing same-origin result syntax and validated geometry', () => {
  assert.equal(studioAssetUrl(assetUrl), assetUrl);
  assert.deepEqual(parseStudioDocument(document), document);
  for (const url of ['javascript:alert(1)', '//example.invalid/picture.png', 'data:image/png;base64,a', assetUrl + '&secret=x', assetUrl + '#frag']) {
    assert.throws(() => studioAssetUrl(url), { status: 400 });
  }
  assert.throws(() => parseStudioDocument({ ...document, kind: 'html' }), { status: 400 });
});

test('a fresh design uses the current brief without reusing claims from an old copy', async () => {
  const updated = {
    ...document,
    brief: '推广春季茶饮，售价29元。',
    copy: { ...emptyStudioCopy(), title: '上一款冷萃', caption: '原优惠19元。' },
  };
  const directions = (headline: string) => JSON.stringify({
    boards: [board, { ...board, id: 'alternate' }].map(item => ({ ...item, layers: [{ ...text, text: headline }] })),
  });
  await assert.rejects(generateStudio('design', updated, {}, async () => directions('原优惠19元。')), { status: 502 });
  const result = await generateStudio('design', updated, {}, async messages => {
    assert.match(messages[1].content, /售价29元/);
    assert.doesNotMatch(messages[1].content, /上一款冷萃|19元/);
    return directions('春季茶饮，售价29元。');
  });
  assert.equal(result.boards?.[0].layers[0].text, '春季茶饮，售价29元。');
});
