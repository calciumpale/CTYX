import assert from 'node:assert/strict';
import test from 'node:test';
import {strFromU8, unzipSync} from 'fflate';
import {buildStudioCodeZip, readAuthorizedStudioImage, studioLayerStyle} from '../app/lib/creative-studio-export.ts';
import {emptyStudioCopy, type StudioDocument, type StudioLayer} from '../app/lib/creative-studio-types.ts';

const imageUrl = '/api/marketing-materials/result?taskId=task-private&fileIndex=0';
const title = '<image onerror="alert(1)"> {{ dangerous }} </script>';
const layer: StudioLayer = {
  id: 'layer-1', kind: 'text', name: '内容', text: title, assetUrl: '',
  x: 15, y: 30, width: 80, height: 20, fill: '#ffffff', color: '#181a1d',
  fontSize: 42, radius: 8, weight: 'bold', align: 'left',
};
const document: StudioDocument = {
  title, kind: 'poster', brief: '', audience: '', channel: '', style: '', copy: emptyStudioCopy(),
  boards: [{
    id: 'board-1', name: title, width: 1080, height: 1350, background: '#f5f5f5',
    layers: [layer, {...layer, id: 'layer-2', kind: 'image', assetUrl: imageUrl}],
  }],
};
const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

test('the canvas and export share artboard-relative geometry and reject invalid style values', () => {
  const style = studioLayerStyle({...layer, fill: 'red; background:url(https://invalid)'});
  assert.equal(style.left, '15%');
  assert.equal(style.top, '30%');
  assert.equal(style.width, '80%');
  assert.equal(style.height, '20%');
  assert.equal(style.fontSize, '42px');
  assert.equal(style.borderRadius, '8px');
  assert.equal(style.backgroundColor, 'transparent');
});

test('code exports keep dimensions, safe literal content, and include referenced images with local paths', async () => {
  for (const target of ['html', 'react', 'vue', 'uni-app'] as const) {
    const zip = await buildStudioCodeZip(document, target, async (url) => {
      assert.equal(url, imageUrl);
      return {bytes: image, type: 'image/png'};
    });
    const files = unzipSync(zip);
    const source = strFromU8(files[target === 'html' ? 'index.html' :
      target === 'react' ? 'App.jsx' : target === 'vue' ? 'App.vue' : 'pages/index/index.vue']);
    assert.match(source, /1080px/);
    assert.match(source, /1350px/);
    assert.ok(!source.includes('<image onerror="'));
    assert.ok(!source.includes('task-private'));
    assert.match(source, /image-1\.png/);
    assert.deepEqual(files[(target === 'uni-app' ? 'static' : target === 'html' ? 'assets' : 'public/assets') + '/image-1.png'], image);
    if (target === 'uni-app') assert.equal(JSON.parse(strFromU8(files['pages.json'])).pages[0].path, 'pages/index/index');
    if (target === 'react' || target === 'vue') assert.ok(files['package.json']);
  }
});

test('code export rejects inaccessible images instead of publishing a private URL', async () => {
  await assert.rejects(buildStudioCodeZip(document, 'html', async () => {
    throw new Error('图片读取失败');
  }), /图片读取失败/);
  await assert.rejects(readAuthorizedStudioImage('https://example.com/image.png'), /工作台图片/);
  await assert.rejects(readAuthorizedStudioImage('/api/marketing-materials/result?taskId=t&fileIndex=0&token=x'), /工作台图片/);
});
