import { DomainError } from './domain.ts';
import { STUDIO_KINDS } from './creative-studio-types.ts';
import type { StudioBoard, StudioCopy, StudioDocument, StudioLayer, StudioSelection } from './creative-studio-types.ts';

const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const markup = /<(?:\/?[a-z][^>]*|![^>]*|\?[^>]*)>/i;
const externalUrl = /(?:\b(?:https?|data|blob|javascript|file|ftp):|\bwww\.|\b[a-z0-9-]+\.(?:com|cn|net|org|io|ai|co)\b|(?:^|\s)\/\/)/i;
const colorPattern = /^(?:transparent|#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8}))$/i;
const idPattern = /^[A-Za-z0-9_.:-]{1,100}$/;
const privateMaterialPath = '/api/marketing-materials/result';
const field = (label: string): never => { throw new DomainError(`请检查${label}的格式与长度`, 400); };

export function studioObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return field(label);
  return value as Record<string, unknown>;
}

export function studioId(value: unknown, label = '标识'): string {
  if (typeof value !== 'string' || !idPattern.test(value)) return field(label);
  return value;
}

export function studioVersion(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) return field('版本');
  return value;
}

export function studioText(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || control.test(value) || markup.test(value) || required && !value.trim()) return field(label);
  return value;
}

export function studioChoice<const T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return field(label);
  return value as T;
}

function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) return field(label);
  return value;
}

function list(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return field(label);
  return value;
}

function color(value: unknown, label: string): string {
  if (typeof value !== 'string' || !colorPattern.test(value)) return field(label);
  return value;
}

function uniqueIds<T extends { id: string }>(items: T[], label: string): T[] {
  if (new Set(items.map(item => item.id)).size !== items.length) return field(label);
  return items;
}

export function studioAssetUrl(value: unknown): string {
  if (value === '') return value;
  if (typeof value !== 'string' || value.length > 200 || !value.startsWith(privateMaterialPath + '?')) return field('图片地址');
  const url = new URL(value, 'https://workspace.invalid');
  const taskId = url.searchParams.get('taskId');
  const fileIndex = url.searchParams.get('fileIndex');
  const index = Number(fileIndex);
  if (url.hash || url.searchParams.size !== 2 || !taskId || !idPattern.test(taskId) || !Number.isSafeInteger(index) || index < 0 || String(index) !== fileIndex) return field('图片地址');
  return `${privateMaterialPath}?taskId=${encodeURIComponent(taskId)}&fileIndex=${fileIndex}`;
}

export function parseStudioCopy(value: unknown): StudioCopy {
  const data = studioObject(value, '文案', ['title', 'caption', 'script', 'coverPrompt', 'shots']);
  return {
    title: studioText(data.title, '文案标题', 160),
    caption: studioText(data.caption, '推广文案', 4000),
    script: studioText(data.script, '视频脚本', 6000),
    coverPrompt: studioText(data.coverPrompt, '封面构思', 1800),
    shots: list(data.shots, '分镜', 0, 12).map(value => {
      const shot = studioObject(value, '分镜', ['visual', 'voiceover', 'seconds']);
      return {
        visual: studioText(shot.visual, '画面描述', 500),
        voiceover: studioText(shot.voiceover, '旁白', 500),
        seconds: number(shot.seconds, '分镜时长', 1, 120, true),
      };
    }),
  };
}

function parseLayer(value: unknown): StudioLayer {
  const data = studioObject(value, '图层', ['id', 'kind', 'name', 'text', 'assetUrl', 'x', 'y', 'width', 'height', 'fill', 'color', 'fontSize', 'radius', 'weight', 'align']);
  const kind = studioChoice(data.kind, ['text', 'image', 'shape', 'button'], '图层类型');
  const assetUrl = studioAssetUrl(data.assetUrl);
  if (assetUrl && kind !== 'image') return field('图片图层');
  return {
    id: studioId(data.id, '图层标识'),
    kind,
    name: studioText(data.name, '图层名称', 120),
    text: studioText(data.text, '图层文字', 1200),
    assetUrl,
    x: number(data.x, '横坐标', 0, 100),
    y: number(data.y, '纵坐标', 0, 100),
    width: number(data.width, '图层宽度', 1, 100),
    height: number(data.height, '图层高度', 1, 100),
    fill: color(data.fill, '填充颜色'),
    color: color(data.color, '文字颜色'),
    fontSize: number(data.fontSize, '字号', 1, 512),
    radius: number(data.radius, '圆角', 0, 2048),
    weight: studioChoice(data.weight, ['normal', 'bold'], '字重'),
    align: studioChoice(data.align, ['left', 'center', 'right'], '对齐方式'),
  };
}

export function parseStudioBoards(value: unknown, min = 0, max = 8): StudioBoard[] {
  const boards = list(value, '画板', min, max).map(value => {
    const data = studioObject(value, '画板', ['id', 'name', 'width', 'height', 'background', 'layers']);
    return {
      id: studioId(data.id, '画板标识'),
      name: studioText(data.name, '画板名称', 120),
      width: number(data.width, '画板宽度', 1, 4096, true),
      height: number(data.height, '画板高度', 1, 4096, true),
      background: color(data.background, '画板背景颜色'),
      layers: uniqueIds(list(data.layers, '图层', 0, 40).map(parseLayer), '图层标识'),
    };
  });
  return uniqueIds(boards, '画板标识');
}

export function parseStudioDocument(value: unknown): StudioDocument {
  const data = studioObject(value, '创作项目', ['title', 'kind', 'brief', 'audience', 'channel', 'style', 'copy', 'boards']);
  return {
    title: studioText(data.title, '项目名称', 120, true).trim(),
    kind: studioChoice(data.kind, STUDIO_KINDS, '设计类型'),
    brief: studioText(data.brief, '创作需求', 8000),
    audience: studioText(data.audience, '目标受众', 400),
    channel: studioText(data.channel, '渠道', 200),
    style: studioText(data.style, '设计风格', 500),
    copy: parseStudioCopy(data.copy),
    boards: parseStudioBoards(data.boards),
  };
}

export function parseStudioSelection(value: unknown): StudioSelection {
  if (value === undefined || value === null) return null;
  const data = studioObject(value, '选中内容', ['boardId', 'layerId']);
  return {
    boardId: studioId(data.boardId, '画板标识'),
    ...(data.layerId !== undefined ? { layerId: studioId(data.layerId, '图层标识') } : {}),
  };
}

export function assertNoStudioOutputUrls(values: string[]): void {
  if (values.some(value => externalUrl.test(value) || value.includes(privateMaterialPath))) return field('生成内容');
}

export function studioMarketBoards(value: unknown, title: string, description: string): StudioBoard[] {
  const boards = parseStudioBoards(value, 1);
  const labels = [title, description, ...boards.flatMap(board => [board.name, ...board.layers.flatMap(layer => [layer.name, layer.text])])];
  if (boards.some(board => board.layers.some(layer => layer.assetUrl)) || labels.some(label => label.includes(privateMaterialPath))) {
    throw new DomainError('模板含私有素材地址，请移除引用或使用占位图层后发布', 400);
  }
  return boards;
}
