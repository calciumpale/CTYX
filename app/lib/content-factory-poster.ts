import type { StudioBoard, StudioLayer } from './creative-studio-types.ts';

export interface FactoryPosterCopy {
  title: string;
  subtitle: string;
  detail: string;
  callToAction: string;
}

const WIDTH = 1080;
const HEIGHT = 1440;

function layer(id: string, name: string, x: number, y: number, width: number, height: number, fill: string, radius = 0): StudioLayer {
  return {
    id, name, kind: 'shape', text: '', assetUrl: '',
    x: x / WIDTH * 100, y: y / HEIGHT * 100, width: width / WIDTH * 100, height: height / HEIGHT * 100,
    fill, color: 'transparent', fontSize: 32, radius, weight: 'normal', align: 'left',
  };
}

function fitText(text: string, width: number, fontSize: number) {
  const lines: string[] = [];
  let line = '';
  let used = 0;
  // Leave room for the browser's CJK fallback glyphs. Keep dates and numbers together when they fit.
  const words = text.match(/[A-Za-z0-9]+(?:[.,][A-Za-z0-9]+)*|./gu) ?? [];
  const limit = Math.floor(width / fontSize);
  for (const word of words.flatMap(word => word.length > limit ? Array.from(word) : [word])) {
    const units = /^[\x20-\x7e]+$/.test(word) ? word.length : 1.25;
    const pixels = units * fontSize;
    if (line && used + pixels > width) {
      lines.push(line.trimEnd());
      line = '';
      used = 0;
    }
    if (!line && word === ' ') continue;
    line += word;
    used += pixels;
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}

function textLayer(
  id: string, name: string, text: string, color: string,
  x: number, y: number, width: number, height: number, size: number, weight: StudioLayer['weight'] = 'normal',
): StudioLayer[] {
  if (!text) return [];
  let fontSize = size;
  let lines = fitText(text, width, fontSize);
  while (lines.length * fontSize * 1.2 >= height && fontSize > 18) {
    fontSize -= 2;
    lines = fitText(text, width, fontSize);
  }
  return [{ ...layer(id, name, x, y, width, height, 'transparent'), kind: 'text', text: lines.join('\n'), color, fontSize, weight }];
}

export function renderFactoryPosters(primary: FactoryPosterCopy, secondary = primary): StudioBoard[] {
  return [
    {
      id: crypto.randomUUID(), name: '深蓝 · 主题版', width: WIDTH, height: HEIGHT, background: '#14233e',
      layers: [
        layer('disc', '圆形图案', 680, 68, 330, 330, '#23395b', 165),
        layer('ring', '圆形轮廓', 770, 114, 240, 240, '#324b70', 120),
        layer('ring-center', '圆形镂空', 787, 131, 206, 206, '#23395b', 103),
        layer('divider', '分隔线', 90, 164, 132, 16, '#dfbc78'),
        ...(primary.detail || primary.callToAction ? [layer('detail-panel', '信息底板', 88, 956, 904, 404, '#f4eddb', 28)] : []),
        ...textLayer('headline', '主标题', primary.title, '#ffffff', 90, 270, 898, 410, 86, 'bold'),
        ...textLayer('subtitle', '副标题', primary.subtitle, '#d9e3f0', 90, 730, 898, 152, 42),
        ...textLayer('detail', '活动要点', primary.detail, '#182b47', 146, 1024, 776, 162, 42, 'bold'),
        ...textLayer('action', '行动文案', primary.callToAction, '#334e75', 146, 1228, 776, 74, 34, 'bold'),
      ],
    },
    {
      id: crypto.randomUUID(), name: '暖白 · 留白版', width: WIDTH, height: HEIGHT, background: '#faf5e9',
      layers: [
        layer('hero', '主视觉底板', 62, 60, 956, 446, '#1a443b', 40),
        layer('hero-disc', '主视觉图案', 456, 84, 398, 398, '#427363', 199),
        layer('hero-inlay', '主视觉图案', 480, 108, 350, 350, '#214f45', 175),
        layer('hero-orbit', '主视觉图案', 316, 154, 258, 258, '#d9b96f', 129),
        layer('hero-orbit-inlay', '主视觉图案', 337, 175, 216, 216, '#1a443b', 108),
        layer('divider', '分隔线', 92, 1020, 892, 16, '#b6ae9c'),
        ...textLayer('headline', '主标题', secondary.title, '#16362f', 92, 552, 892, 328, 72, 'bold'),
        ...textLayer('subtitle', '副标题', secondary.subtitle, '#32574f', 92, 890, 892, 119, 38),
        ...textLayer('detail', '活动要点', secondary.detail, '#16362f', 92, 1064, 892, 162, 40, 'bold'),
        ...textLayer('action', '行动文案', secondary.callToAction, '#32574f', 92, 1260, 892, 80, 34, 'bold'),
      ],
    },
  ];
}
