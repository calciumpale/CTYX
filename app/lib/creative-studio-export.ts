import {strToU8, zipSync} from 'fflate';
import type {StudioBoard, StudioDocument, StudioLayer} from './creative-studio-types.ts';

export type StudioCodeTarget = 'html' | 'react' | 'vue' | 'uni-app';
type ImageFile = {bytes: Uint8Array; type: string};
type ReadImage = (url: string) => Promise<ImageFile>;

const FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
const IMAGE_TYPES = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif'], ['image/avif', 'avif'],
]);

export function studioColor(value: string, fallback: string): string {
  return /^(?:transparent|#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8}))$/i.test(value) ? value : fallback;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function studioBoardSize(board: StudioBoard) {
  return {
    width: Math.max(1, Math.min(4096, Math.round(finite(board.width, 1080)))),
    height: Math.max(1, Math.min(4096, Math.round(finite(board.height, 1080)))),
  };
}

export function studioLayerStyle(layer: StudioLayer) {
  return {
    left: `${finite(layer.x, 0)}%`,
    top: `${finite(layer.y, 0)}%`,
    width: `${Math.max(0, finite(layer.width, 0))}%`,
    height: `${Math.max(0, finite(layer.height, 0))}%`,
    backgroundColor: studioColor(layer.fill, 'transparent'),
    color: studioColor(layer.color, '#171a1e'),
    fontSize: `${Math.max(1, finite(layer.fontSize, 16))}px`,
    borderRadius: `${Math.max(0, finite(layer.radius, 0))}px`,
    fontWeight: layer.weight === 'bold' ? 'bold' : 'normal',
    textAlign: layer.align === 'right' ? 'right' : layer.align === 'center' ? 'center' : 'left',
  } as const;
}

export function studioImagePath(source: string): string {
  const base = 'https://studio.invalid';
  if (source.length > 200 || !source.startsWith('/api/marketing-materials/result?')) throw new Error('仅支持工作台图片');
  const url = new URL(source, base);
  const taskId = url.searchParams.get('taskId');
  const fileIndex = url.searchParams.get('fileIndex');
  if (url.origin !== base || url.pathname !== '/api/marketing-materials/result' || url.hash ||
      url.searchParams.size !== 2 || !taskId || !/^[A-Za-z0-9_.:-]{1,100}$/.test(taskId) || fileIndex === null || !/^[0-3]$/.test(fileIndex)) {
    throw new Error('仅支持工作台图片');
  }
  return url.pathname + '?' + new URLSearchParams({taskId, fileIndex});
}

export async function readAuthorizedStudioImage(source: string): Promise<ImageFile> {
  const response = await fetch(studioImagePath(source), {credentials: 'same-origin', redirect: 'error'});
  const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!response.ok || !IMAGE_TYPES.has(type)) throw new Error('无法读取工作台图片，请确认素材仍可访问');
  return {bytes: new Uint8Array(await response.arrayBuffer()), type};
}

function activeSources(boards: StudioBoard[]) {
  return Array.from(new Set(boards.flatMap(board => board.layers
    .filter(layer => layer.kind === 'image' && layer.assetUrl)
    .map(layer => layer.assetUrl))));
}

const SCREEN_CSS = `.studio-export{display:flex;flex-wrap:wrap;align-items:flex-start;gap:20px;font-family:${FONT}}
.artboard{position:relative;overflow:hidden;flex:none}
.layer{position:absolute;display:block;overflow:hidden;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.2}
.layer-button{display:flex;flex-direction:column;justify-content:center}
.layer-image img,.layer-image image{display:block;width:100%;height:100%;object-fit:cover}`;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function inlineCss(styles: Record<string, string>): string {
  return Object.entries(styles).map(([name, value]) =>
    name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()) + ':' + value).join(';');
}

function htmlPage(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${head}</head>
<body>${body}</body>
</html>
`;
}

function sourceMarkup(document: StudioDocument, target: StudioCodeTarget, images: Map<string, string>) {
  const react = target === 'react';
  const vue = target === 'vue' || target === 'uni-app';
  const uni = target === 'uni-app';
  const outerTag = uni ? 'view' : 'main';
  const boardTag = uni ? 'view' : 'section';
  const classAttribute = react ? 'className' : 'class';
  const content: Record<string, string> = {};
  const literalText = (key: string, value: string) => {
    if (!vue) return react ? '{' + safeJson(value) + '}' : escapeHtml(value);
    content[key] = value;
    return `{{ content.${key} }}`;
  };
  const markup = document.boards.map((board, boardIndex) => {
    const size = studioBoardSize(board);
    const boardStyle = {
      width: size.width + 'px',
      height: size.height + 'px',
      backgroundColor: studioColor(board.background, '#ffffff'),
    };
    const layers = board.layers.map((layer, layerIndex) => {
      const key = `b${boardIndex}l${layerIndex}`;
      const style = studioLayerStyle(layer);
      const styleAttribute = react ? `style={${safeJson(style)}}` : `style="${inlineCss(style)}"`;
      let body = '';
      if (layer.kind === 'image' && layer.assetUrl) {
        const path = images.get(layer.assetUrl) ?? '';
        const assetAttribute = vue ? `:src="content.${key}Image"` :
          react ? `src={${safeJson(path)}}` : `src="${path}"`;
        if (vue) content[key + 'Image'] = path;
        body = uni ? `<image ${assetAttribute} mode="aspectFill" />` :
          `<img ${assetAttribute} alt=""${react ? ' /' : ''}>`;
      } else if (layer.kind === 'text' || layer.kind === 'button') {
        body = literalText(key, layer.text);
        if (uni) body = '<text>' + body + '</text>';
      }
      const tag = uni ? 'view' : 'div';
      const kind = ['text', 'image', 'shape', 'button'].includes(layer.kind) ? layer.kind : 'shape';
      return `    <${tag} ${classAttribute}="layer layer-${kind}" ${styleAttribute}>${body}</${tag}>`;
    });
    const styleAttribute = react ? `style={${safeJson(boardStyle)}}` : `style="${inlineCss(boardStyle)}"`;
    const label = uni ? '' : react ? ` aria-label={${safeJson(board.name)}}` : ` aria-label="${escapeHtml(board.name)}"`;
    return [`  <${boardTag} ${classAttribute}="artboard" ${styleAttribute}${label}>`, ...layers, `  </${boardTag}>`].join('\n');
  }).join('\n');
  return {markup: `<${outerTag} ${classAttribute}="studio-export">\n${markup}\n</${outerTag}>`, content};
}

export async function buildStudioCodeZip(document: StudioDocument, target: StudioCodeTarget, readImage: ReadImage = readAuthorizedStudioImage) {
  const files: Record<string, Uint8Array> = {};
  const paths = new Map<string, string>();
  const put = (name: string, source: string) => { files[name] = strToU8(source); };
  const sources = activeSources(document.boards);
  for (const [index, url] of sources.entries()) {
    studioImagePath(url);
    const {bytes, type} = await readImage(url);
    const extension = IMAGE_TYPES.get(type);
    if (!extension) throw new Error('此图片格式不支持导出');
    const filename = `image-${index + 1}.${extension}`;
    const folder = target === 'uni-app' ? 'static' : target === 'html' ? 'assets' : 'public/assets';
    files[`${folder}/${filename}`] = bytes;
    paths.set(url, target === 'uni-app' ? `/static/${filename}` : `./assets/${filename}`);
  }

  const {markup, content} = sourceMarkup(document, target, paths);
  if (target === 'html') {
    put('index.html', htmlPage(document.title, markup, `<style>body{margin:16px}${SCREEN_CSS}</style>`));
  } else if (target === 'react' || target === 'vue') {
    const react = target === 'react';
    put('package.json', JSON.stringify({
      private: true, type: 'module',
      scripts: {dev: 'vite', build: 'vite build', preview: 'vite preview'},
      dependencies: react ? {react: '^19.0.0', 'react-dom': '^19.0.0'} : {vue: '^3.5.0'},
      devDependencies: react ? {vite: '^7.0.0'} : {vite: '^7.0.0', '@vitejs/plugin-vue': '^6.0.0'},
    }, null, 2));
    put('index.html', htmlPage(document.title, `<div id="app"></div><script type="module" src="./main.${react ? 'jsx' : 'js'}"></script>`));
    if (react) {
      put('main.jsx', "import React from 'react';\nimport {createRoot} from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('app')).render(<App />);\n");
      put('App.jsx', `import React from 'react';\nimport './style.css';\nexport default function App() {\n  return (\n${markup}\n  );\n}\n`);
      put('vite.config.js', "export default {base: './'};\n");
    } else {
      put('main.js', "import {createApp} from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');\n");
      put('App.vue', `<template>\n${markup}\n</template>\n<script setup>\nconst content = ${safeJson(content)};\n</script>\n<style>body{margin:16px}${SCREEN_CSS}</style>\n`);
      put('vite.config.js', "import vue from '@vitejs/plugin-vue';\nexport default {base: './', plugins: [vue()]};\n");
    }
    if (react) put('style.css', 'body{margin:16px}' + SCREEN_CSS);
  } else {
    put('pages/index/index.vue', `<template>\n${markup}\n</template>\n<script>\nexport default {data() { return {content: ${safeJson(content)}}; }};\n</script>\n<style>\n${SCREEN_CSS}\n</style>\n`);
    put('App.vue', '<script>export default {};</script>\n');
    put('main.js', "import {createSSRApp} from 'vue';\nimport App from './App.vue';\nexport function createApp() { return {app: createSSRApp(App)}; }\n");
    put('pages.json', JSON.stringify({pages: [{path: 'pages/index/index', style: {navigationBarTitleText: document.title}}]}, null, 2));
    put('manifest.json', JSON.stringify({name: document.title, appid: '', versionName: '1.0.0', versionCode: '100', vueVersion: '3'}, null, 2));
  }
  put('README.txt', target === 'html' ? '解压后打开 index.html。\n' : target === 'uni-app'
    ? '用 HBuilderX 导入此目录并运行到 H5。发布小程序时填写平台 AppID。\n'
    : '解压后运行 npm install，再运行 npm run dev。构建静态站点请运行 npm run build。\n');
  return zipSync(files);
}

function imageBlob(file: ImageFile) {
  return new Blob([Uint8Array.from(file.bytes)], {type: file.type});
}

async function decodeImage(file: ImageFile): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(imageBlob(file));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function textLines(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    const words = paragraph.match(/\p{Script=Han}|[\p{L}\p{N}]+|[^\p{L}\p{N}]/gu) ?? [];
    for (const word of words) {
      if (line && context.measureText(line + word).width > width) {
        lines.push(line);
        line = '';
      }
      if (context.measureText(word).width <= width) {
        line += word;
        continue;
      }
      for (const character of word) {
        if (line && context.measureText(line + character).width > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function renderStudioBoardPng(board: StudioBoard): Promise<Blob> {
  const size = studioBoardSize(board);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法导出画布');
  const images = new Map<string, HTMLImageElement>();
  for (const source of activeSources([board])) images.set(source, await decodeImage(await readAuthorizedStudioImage(source)));

  context.fillStyle = studioColor(board.background, '#ffffff');
  context.fillRect(0, 0, size.width, size.height);
  for (const layer of board.layers) {
    const style = studioLayerStyle(layer);
    const x = parseFloat(style.left) * size.width / 100;
    const y = parseFloat(style.top) * size.height / 100;
    const width = parseFloat(style.width) * size.width / 100;
    const height = parseFloat(style.height) * size.height / 100;
    if (width <= 0 || height <= 0) continue;
    context.save();
    context.beginPath();
    context.roundRect(x, y, width, height, Math.min(parseFloat(style.borderRadius), width / 2, height / 2));
    context.clip();
    context.fillStyle = style.backgroundColor;
    context.fillRect(x, y, width, height);
    const image = layer.kind === 'image' && images.get(layer.assetUrl);
    if (image) {
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const imageWidth = image.naturalWidth * scale;
      const imageHeight = image.naturalHeight * scale;
      context.drawImage(image, x + (width - imageWidth) / 2, y + (height - imageHeight) / 2, imageWidth, imageHeight);
    } else if (layer.kind === 'text' || layer.kind === 'button') {
      context.font = `${style.fontWeight} ${style.fontSize} ${FONT}`;
      context.fillStyle = style.color;
      context.textAlign = style.textAlign;
      context.textBaseline = 'middle';
      const lines = textLines(context, layer.text, width);
      const lineHeight = parseFloat(style.fontSize) * 1.2;
      const textX = style.textAlign === 'right' ? x + width : style.textAlign === 'center' ? x + width / 2 : x;
      const textTop = y + (layer.kind === 'button' ? (height - lines.length * lineHeight) / 2 : 0);
      lines.forEach((line, index) => context.fillText(line, textX, textTop + (index + .5) * lineHeight));
    }
    context.restore();
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画布图片导出失败')), 'image/png'));
}

export function downloadStudioBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-') || 'creative-studio';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
