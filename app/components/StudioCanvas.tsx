'use client';

import {useEffect, useRef, useState} from 'react';
import type {KeyboardEvent, PointerEvent, ReactNode} from 'react';
import {ChevronDown, ChevronUp, Code2, Copy, Download, Image as ImageIcon, Layers, Maximize2, Minus, MousePointer2, Plus, Square, Trash2, Type} from 'lucide-react';
import {buildStudioCodeZip, downloadStudioBlob, renderStudioBoardPng, studioBoardSize, studioColor, studioImagePath, studioLayerStyle} from '../lib/creative-studio-export.ts';
import type {StudioCodeTarget} from '../lib/creative-studio-export.ts';
import type {StudioBoard, StudioDocument, StudioImage, StudioKind, StudioLayer, StudioSelection} from '../lib/creative-studio-types.ts';
import './studio-canvas.css';

interface CanvasProps {
  document: StudioDocument;
  onChange: (document: StudioDocument) => void;
  selection: StudioSelection;
  onSelectionChange: (selection: StudioSelection) => void;
  images: StudioImage[];
  disabled?: boolean;
  notify: (message: string) => void;
}

const KIND_LABELS = {text: '文字', image: '图片', shape: '形状', button: '按钮'};
const KIND_ICONS = {text: Type, image: ImageIcon, shape: Square, button: MousePointer2};
const BOARD_PRESETS: Record<StudioKind, Array<{label: string; width: number; height: number}>> = {
  poster: [
    {label: '正方形 1:1', width: 1080, height: 1080},
    {label: '图文 4:5', width: 1080, height: 1350},
    {label: '竖版 9:16', width: 1080, height: 1920},
    {label: '横版 16:9', width: 1920, height: 1080},
  ],
  web: [{label: '桌面网页', width: 1440, height: 900}, {label: '移动网页', width: 390, height: 844}],
  app: [{label: '手机 App', width: 390, height: 844}, {label: '平板 App', width: 820, height: 1180}],
  mini: [{label: '微信小程序', width: 375, height: 812}],
};
const CODE_TARGETS: Array<{value: StudioCodeTarget; label: string}> = [
  {value: 'html', label: 'HTML'}, {value: 'react', label: 'React'},
  {value: 'vue', label: 'Vue'}, {value: 'uni-app', label: 'uni-app'},
];

const bounded = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const shortCopy = (name: string) => name.slice(0, 116) + ' 副本';
const uniqueId = () => crypto.randomUUID();

function LayerContent({layer, imageUrl}: {layer: StudioLayer; imageUrl?: string}) {
  if (layer.kind === 'image') return imageUrl
    ? <img src={imageUrl} alt="" draggable={false} />
    : <span className="studio-canvas-image-placeholder"><ImageIcon aria-hidden="true" /></span>;
  if (layer.kind === 'button' || layer.kind === 'text') return <span>{layer.text}</span>;
  return null;
}

function ArtboardSurface({board, scale, children}: {
  board: StudioBoard;
  scale: number;
  children?: (layer: StudioLayer, imageUrl?: string) => ReactNode;
}) {
  const size = studioBoardSize(board);
  return <div className="studio-canvas-board-window" style={{width: size.width * scale, height: size.height * scale}}>
    <div className="studio-canvas-board-surface" style={{
      width: size.width, height: size.height,
      transform: 'scale(' + scale + ')',
      backgroundColor: studioColor(board.background, '#ffffff'),
    }}>
      {board.layers.map(layer => {
        let source: string | undefined;
        if (layer.kind === 'image' && layer.assetUrl) {
          try {
            source = studioImagePath(layer.assetUrl);
          } catch {
            source = undefined;
          }
        }
        return children ? children(layer, source) :
          <div className={'studio-canvas-layer kind-' + layer.kind} key={layer.id} style={studioLayerStyle(layer)}>
            <LayerContent layer={layer} imageUrl={source} />
          </div>;
      })}
    </div>
  </div>;
}

export function BoardPreview({board, maxWidth = 260, maxHeight = 320}: {
  board: StudioBoard;
  images: StudioImage[];
  maxWidth?: number;
  maxHeight?: number;
}) {
  const size = studioBoardSize(board);
  const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  return <div className="studio-canvas-board-preview" role="img" aria-label={board.name || '画板'}>
    <ArtboardSurface board={board} scale={scale} />
  </div>;
}

function NumberField({label, value, min, max, step = 1, change}: {
  label: string; value: number; min: number; max: number; step?: number; change: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label className="studio-canvas-field">
    {label}
    <input type="number" value={draft ?? String(value)} min={min} max={max} step={step}
      onChange={event => {
        const text = event.target.value;
        setDraft(text);
        const next = Number(text);
        if (text !== '' && Number.isFinite(next) && next >= min && next <= max) {
          change(step === 1 ? Math.round(next) : Math.round(next * 10) / 10);
        }
      }}
      onBlur={() => {
        if (draft !== null && draft !== '' && Number.isFinite(Number(draft))) {
          const next = bounded(Number(draft), min, max);
          const normalized = step === 1 ? Math.round(next) : Math.round(next * 10) / 10;
          if (normalized !== value) change(normalized);
        }
        setDraft(null);
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(null);
      }} />
  </label>;
}

function swatch(value: string, fallback: string) {
  if (/^#[a-f\d]{6}$/i.test(value)) return value;
  if (/^#[a-f\d]{8}$/i.test(value)) return value.slice(0, 7);
  if (/^#[a-f\d]{3,4}$/i.test(value)) return '#' + [...value.slice(1, 4)].map(x => x + x).join('');
  return fallback;
}

function ColorField({label, value, change, transparent = false}: {
  label: string; value: string; change: (value: string) => void; transparent?: boolean;
}) {
  return <div className="studio-canvas-color-field">
    <label className="studio-canvas-field">
      {label}
      <input type="color" value={swatch(value, '#ffffff')} onChange={event => change(event.target.value)} />
    </label>
    {transparent && <button type="button" className="studio-canvas-plain" aria-pressed={value === 'transparent'}
      onClick={() => change(value === 'transparent' ? '#ffffff' : 'transparent')}>透明</button>}
  </div>;
}

function DeviceChrome({kind}: {kind: StudioKind}) {
  if (kind === 'poster') return null;
  if (kind === 'web') return <div className="studio-canvas-browser" aria-hidden="true"><span /><span /><span /><div /></div>;
  return <div className="studio-canvas-phone" aria-hidden="true">
    <span>9:41</span>{kind === 'mini' ? <span className="studio-canvas-mini-indicator"><i /><i /></span> : <span className="studio-canvas-phone-island" />}
  </div>;
}

interface DragState {
  boardId: string;
  layerId: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  scaledWidth: number;
  scaledHeight: number;
  maxX: number;
  maxY: number;
  nextX: number;
  nextY: number;
}

export default function StudioCanvas({document, onChange, selection, onSelectionChange, images, disabled = false, notify}: CanvasProps) {
  const [zoom, setZoom] = useState(1);
  const [target, setTarget] = useState<StudioCodeTarget>('html');
  const [exporting, setExporting] = useState<'png' | 'zip' | null>(null);
  const [motion, setMotion] = useState<DragState | null>(null);
  const drag = useRef<DragState | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(0);

  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  const board = document.boards.find(item => item.id === selection?.boardId) ?? document.boards[0];
  const layer = board?.layers.find(item => item.id === selection?.layerId);
  const presets = BOARD_PRESETS[document.kind];

  const updateBoard = (id: string, edit: (item: StudioBoard) => StudioBoard) => {
    onChange({...document, boards: document.boards.map(item => item.id === id ? edit(item) : item)});
  };
  const patchBoard = (patch: Partial<StudioBoard>) => {
    if (board) updateBoard(board.id, item => ({...item, ...patch}));
  };
  const patchLayerAt = (boardId: string, layerId: string, patch: Partial<StudioLayer>) => {
    updateBoard(boardId, item => ({
      ...item, layers: item.layers.map(entry => entry.id === layerId ? {...entry, ...patch} : entry),
    }));
  };
  const patchLayer = (patch: Partial<StudioLayer>) => {
    if (board && layer) patchLayerAt(board.id, layer.id, patch);
  };

  function addBoard() {
    if (document.boards.length >= 8) return;
    const {width, height} = presets[0];
    const added: StudioBoard = {id: uniqueId(), name: '画板 ' + (document.boards.length + 1),
      width, height, background: '#ffffff', layers: []};
    onChange({...document, boards: [...document.boards, added]});
    onSelectionChange({boardId: added.id});
  }

  function duplicateBoard() {
    if (!board || document.boards.length >= 8) return;
    const duplicate = {...board, id: uniqueId(), name: shortCopy(board.name),
      layers: board.layers.map(item => ({...item, id: uniqueId()}))};
    const index = document.boards.indexOf(board) + 1;
    const boards = [...document.boards];
    boards.splice(index, 0, duplicate);
    onChange({...document, boards});
    onSelectionChange({boardId: duplicate.id});
  }

  function removeBoard() {
    if (!board) return;
    const index = document.boards.indexOf(board);
    const boards = document.boards.filter(item => item.id !== board.id);
    const next = boards[index] ?? boards[index - 1];
    onChange({...document, boards});
    onSelectionChange(next ? {boardId: next.id} : null);
  }

  function addLayer(kind: StudioLayer['kind']) {
    if (!board || board.layers.length >= 40) return;
    const button = kind === 'button';
    const text = kind === 'text';
    const added: StudioLayer = {
      id: uniqueId(), kind, name: KIND_LABELS[kind], text: text ? '编辑文字' : button ? '了解详情' : '',
      assetUrl: kind === 'image' ? images[0]?.url ?? '' : '',
      x: 10, y: 12, width: text ? 74 : button ? 38 : 54, height: text || button ? 13 : 42,
      fill: button ? '#19202b' : kind === 'shape' ? '#dde2ea' : 'transparent',
      color: button ? '#ffffff' : '#19202b', fontSize: Math.max(12, Math.round(board.width * (text ? .07 : .038))),
      radius: button ? 10 : 0, weight: text ? 'bold' : 'normal', align: button ? 'center' : 'left',
    };
    patchBoard({layers: [...board.layers, added]});
    onSelectionChange({boardId: board.id, layerId: added.id});
  }

  function reorderLayer(direction: -1 | 1) {
    if (!board || !layer) return;
    const from = board.layers.indexOf(layer);
    const to = from + direction;
    if (to < 0 || to >= board.layers.length) return;
    const layers = [...board.layers];
    [layers[from], layers[to]] = [layers[to], layers[from]];
    patchBoard({layers});
  }

  function duplicateLayer() {
    if (!board || !layer || board.layers.length >= 40) return;
    const duplicate = {...layer, id: uniqueId(), name: shortCopy(layer.name), x: Math.min(100, layer.x + 2), y: Math.min(100, layer.y + 2)};
    const layers = [...board.layers];
    layers.splice(board.layers.indexOf(layer) + 1, 0, duplicate);
    patchBoard({layers});
    onSelectionChange({boardId: board.id, layerId: duplicate.id});
  }

  function removeLayer() {
    if (!board || !layer) return;
    patchBoard({layers: board.layers.filter(item => item.id !== layer.id)});
    onSelectionChange({boardId: board.id});
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>, source: StudioBoard, item: StudioLayer, scale: number) {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelectionChange({boardId: source.id, layerId: item.id});
    if (disabled) return;
    const size = studioBoardSize(source);
    const next = {
      boardId: source.id, layerId: item.id, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: item.x, y: item.y,
      scaledWidth: size.width * scale, scaledHeight: size.height * scale,
      maxX: Math.max(item.x, 100 - item.width), maxY: Math.max(item.y, 100 - item.height),
      nextX: item.x, nextY: item.y,
    };
    drag.current = next;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const offsetX = (event.clientX - active.startX) * 100 / active.scaledWidth;
    const offsetY = (event.clientY - active.startY) * 100 / active.scaledHeight;
    const nextX = Math.round(bounded(active.x + offsetX, 0, active.maxX) * 10) / 10;
    const nextY = Math.round(bounded(active.y + offsetY, 0, active.maxY) * 10) / 10;
    drag.current = {...active, nextX, nextY};
    setMotion(drag.current);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    drag.current = null;
    setMotion(null);
    if (commit && !disabled && (active.nextX !== active.x || active.nextY !== active.y)) {
      patchLayerAt(active.boardId, active.layerId, {x: active.nextX, y: active.nextY});
    }
  }

  function useLayerKeys(event: KeyboardEvent<HTMLDivElement>, source: StudioBoard, item: StudioLayer) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectionChange({boardId: source.id, layerId: item.id});
      return;
    }
    if (disabled) return;
    const amount = event.shiftKey ? 5 : 1;
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    if (!horizontal && !vertical) return;
    event.preventDefault();
    const coordinate = horizontal ? 'x' : 'y';
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    onSelectionChange({boardId: source.id, layerId: item.id});
    patchLayerAt(source.id, item.id, {[coordinate]: bounded(item[coordinate] + direction * amount, 0, 100)});
  }

  async function exportBoard(format: 'png' | 'zip') {
    if (!board || exporting) return;
    setExporting(format);
    try {
      const file = format === 'png' ? await renderStudioBoardPng(board) :
        new Blob([Uint8Array.from(await buildStudioCodeZip(document, target))], {type: 'application/zip'});
      const name = format === 'png' ? (board.name || '画板') + '.png' : document.title + '-' + target + '.zip';
      downloadStudioBlob(file, name);
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出失败，请稍后重试');
    } finally {
      setExporting(null);
    }
  }

  const layerIndex = board && layer ? board.layers.indexOf(layer) : -1;
  return <section className="studio-canvas" aria-label="设计画布">
    <div className="studio-canvas-tools">
      <div className="studio-canvas-tools-group">
        <button type="button" onClick={addBoard} disabled={disabled || document.boards.length >= 8}>
          <Plus aria-hidden="true" />新画板
        </button>
        <span className="studio-canvas-board-count">{document.boards.length} 个画板</span>
      </div>
      <div className="studio-canvas-tools-group studio-canvas-export-tools">
        <button type="button" onClick={() => void exportBoard('png')} disabled={disabled || !board || !!exporting}>
          <Download aria-hidden="true" />{exporting === 'png' ? '正在导出' : '导出 PNG'}
        </button>
        <select aria-label="代码导出格式" value={target} onChange={event => setTarget(event.target.value as StudioCodeTarget)} disabled={disabled || !board || !!exporting}>
          {CODE_TARGETS.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}
        </select>
        <button type="button" onClick={() => void exportBoard('zip')} disabled={disabled || !board || !!exporting}>
          <Code2 aria-hidden="true" />{exporting === 'zip' ? '正在导出' : '代码 ZIP'}
        </button>
      </div>
    </div>
    <div className="studio-canvas-body">
      <div className="studio-canvas-stage" ref={stage}>
        <div className="studio-canvas-scroll" tabIndex={0} role="region" aria-label="画板浏览区">
          {document.boards.length ? <div className="studio-canvas-artboards">
            {document.boards.map((item, index) => {
              const size = studioBoardSize(item);
              const available = stageWidth ? Math.max(100, stageWidth - 60) : 360;
              const base = Math.min(1, Math.min(360, available) / size.width, 365 / size.height);
              const scale = base * zoom;
              const selected = board?.id === item.id;
              return <figure key={item.id} className={'studio-canvas-artboard studio-canvas-device-' + document.kind} data-selected={selected}>
                <figcaption>
                  <button type="button" aria-pressed={selected && !layer} onClick={() => onSelectionChange({boardId: item.id})}>
                    {item.name || '画板 ' + (index + 1)}
                  </button>
                  <span>{item.width} × {item.height}</span>
                </figcaption>
                <div className="studio-canvas-frame" onPointerDown={event => {
                  if (event.button === 0) onSelectionChange({boardId: item.id});
                }}>
                  <DeviceChrome kind={document.kind} />
                  <ArtboardSurface board={item} scale={scale}>
                    {(entry, source) => {
                      const dragged = motion?.boardId === item.id && motion.layerId === entry.id;
                      const shape = dragged ? {...entry, x: motion.nextX, y: motion.nextY} : entry;
                      return <div key={entry.id} className={'studio-canvas-layer studio-canvas-editable kind-' + entry.kind}
                        style={studioLayerStyle(shape)} role="button" tabIndex={0}
                        aria-label={entry.name || KIND_LABELS[entry.kind]} aria-pressed={selected && layer?.id === entry.id}
                        onKeyDown={event => useLayerKeys(event, item, entry)}
                        onPointerDown={event => beginDrag(event, item, entry, scale)}
                        onPointerMove={moveDrag} onPointerUp={event => endDrag(event, true)}
                        onPointerCancel={event => endDrag(event, false)} onLostPointerCapture={event => endDrag(event, false)}>
                        <LayerContent layer={entry} imageUrl={source} />
                      </div>;
                    }}
                  </ArtboardSurface>
                  {document.kind === 'app' && <div className="studio-canvas-phone-bottom" aria-hidden="true" />}
                </div>
              </figure>;
            })}
          </div> : <div className="studio-canvas-empty">
            <Layers aria-hidden="true" /><p>画板会显示在这里</p>
            <button type="button" disabled={disabled} onClick={addBoard}><Plus aria-hidden="true" />新画板</button>
          </div>}
        </div>
        {!!document.boards.length && <div className="studio-canvas-zoom" role="group" aria-label="画布缩放">
          <button type="button" aria-label="缩小" title="缩小" disabled={zoom <= .5}
            onClick={() => setZoom(current => Math.max(.5, current - .125))}><Minus aria-hidden="true" /></button>
          <output aria-live="polite">{Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="放大" title="放大" disabled={zoom >= 2}
            onClick={() => setZoom(current => Math.min(2, current + .125))}><Plus aria-hidden="true" /></button>
          <button type="button" aria-label="适合画布" title="适合画布" onClick={() => setZoom(1)}><Maximize2 aria-hidden="true" /></button>
        </div>}
      </div>
      {board && <aside className="studio-canvas-inspector" aria-label="画板与图层属性">
        <fieldset className="studio-canvas-properties" disabled={disabled} key={board.id}>
          <legend>画板</legend>
          <div className="studio-canvas-inspector-actions">
            <button type="button" aria-label="复制画板" title="复制画板" onClick={duplicateBoard}
              disabled={document.boards.length >= 8}><Copy aria-hidden="true" /></button>
            <button type="button" aria-label="删除画板" title="删除画板" onClick={removeBoard}><Trash2 aria-hidden="true" /></button>
          </div>
          <label className="studio-canvas-field">名称<input value={board.name} maxLength={120} onChange={event => patchBoard({name: event.target.value})} /></label>
          <label className="studio-canvas-field">尺寸预设
            <select value={presets.some(item => item.width === board.width && item.height === board.height) ? board.width + 'x' + board.height : ''}
              onChange={event => {
                const match = presets.find(item => item.width + 'x' + item.height === event.target.value);
                if (match) patchBoard({width: match.width, height: match.height});
              }}>
              <option value="">自定义</option>
              {presets.map(item => <option key={item.label} value={item.width + 'x' + item.height}>{item.label}</option>)}
            </select>
          </label>
          <div className="studio-canvas-field-pair">
            <NumberField label="宽度 (px)" value={board.width} min={1} max={4096} change={width => patchBoard({width})} />
            <NumberField label="高度 (px)" value={board.height} min={1} max={4096} change={height => patchBoard({height})} />
          </div>
          <ColorField label="背景" value={board.background} change={background => patchBoard({background})} transparent />
        </fieldset>
        <fieldset className="studio-canvas-properties studio-canvas-layer-panel" disabled={disabled}>
          <legend>图层</legend>
          <div className="studio-canvas-layer-tools" role="group" aria-label="添加图层">
            {(Object.keys(KIND_LABELS) as StudioLayer['kind'][]).map(kind => {
              const Icon = KIND_ICONS[kind];
              return <button type="button" title={'添加' + KIND_LABELS[kind]} aria-label={'添加' + KIND_LABELS[kind]}
                key={kind} disabled={board.layers.length >= 40} onClick={() => addLayer(kind)}><Icon aria-hidden="true" /></button>;
            })}
          </div>
          {board.layers.length ? <ul className="studio-canvas-layer-list">
            {[...board.layers].reverse().map(item => {
              const Icon = KIND_ICONS[item.kind];
              return <li key={item.id}><button type="button" aria-pressed={item.id === layer?.id}
                onClick={() => onSelectionChange({boardId: board.id, layerId: item.id})}>
                <Icon aria-hidden="true" /><span>{item.name || KIND_LABELS[item.kind]}</span>
              </button></li>;
            })}
          </ul> : <p className="studio-canvas-no-layers">当前画板没有图层</p>}
        </fieldset>
        {layer && <fieldset className="studio-canvas-properties" key={board.id + '/' + layer.id} disabled={disabled}>
          <legend>{KIND_LABELS[layer.kind]}属性</legend>
          <div className="studio-canvas-inspector-actions">
            <button type="button" aria-label="上移图层" title="上移图层" disabled={layerIndex >= board.layers.length - 1}
              onClick={() => reorderLayer(1)}><ChevronUp aria-hidden="true" /></button>
            <button type="button" aria-label="下移图层" title="下移图层" disabled={layerIndex < 1}
              onClick={() => reorderLayer(-1)}><ChevronDown aria-hidden="true" /></button>
            <button type="button" aria-label="复制图层" title="复制图层" disabled={board.layers.length >= 40}
              onClick={duplicateLayer}><Copy aria-hidden="true" /></button>
            <button type="button" aria-label="删除图层" title="删除图层" onClick={removeLayer}><Trash2 aria-hidden="true" /></button>
          </div>
          <label className="studio-canvas-field">图层名称<input value={layer.name} maxLength={120} onChange={event => patchLayer({name: event.target.value})} /></label>
          {(layer.kind === 'text' || layer.kind === 'button') && <>
            <label className="studio-canvas-field">内容<textarea rows={3} maxLength={1200} value={layer.text} onChange={event => patchLayer({text: event.target.value})} /></label>
            <div className="studio-canvas-field-pair">
              <NumberField label="字号 (px)" value={layer.fontSize} min={1} max={512} change={fontSize => patchLayer({fontSize})} />
              <label className="studio-canvas-field">字重<select value={layer.weight} onChange={event => patchLayer({weight: event.target.value as StudioLayer['weight']})}>
                <option value="normal">常规</option><option value="bold">粗体</option>
              </select></label>
            </div>
            <div className="studio-canvas-field-pair">
              <label className="studio-canvas-field">对齐<select value={layer.align} onChange={event => patchLayer({align: event.target.value as StudioLayer['align']})}>
                <option value="left">靠左</option><option value="center">居中</option><option value="right">靠右</option>
              </select></label>
              <ColorField label="文字颜色" value={layer.color} change={color => patchLayer({color})} />
            </div>
          </>}
          {layer.kind === 'image' && <label className="studio-canvas-field">工作台素材
            <select value={layer.assetUrl} onChange={event => patchLayer({assetUrl: event.target.value})}>
              <option value="">选择已生成的图片</option>
              {layer.assetUrl && !images.some(image => image.url === layer.assetUrl) && <option value={layer.assetUrl}>当前素材不可预览</option>}
              {images.map(image => <option key={image.url} value={image.url}>{image.name}</option>)}
            </select>
          </label>}
          <div className="studio-canvas-field-pair">
            <NumberField label="左侧 (%)" value={layer.x} min={0} max={100} step={.1} change={x => patchLayer({x})} />
            <NumberField label="顶部 (%)" value={layer.y} min={0} max={100} step={.1} change={y => patchLayer({y})} />
            <NumberField label="宽度 (%)" value={layer.width} min={1} max={100} step={.1} change={width => patchLayer({width})} />
            <NumberField label="高度 (%)" value={layer.height} min={1} max={100} step={.1} change={height => patchLayer({height})} />
          </div>
          <div className="studio-canvas-field-pair">
            <ColorField label="填充" value={layer.fill} change={fill => patchLayer({fill})} transparent />
            <NumberField label="圆角 (px)" value={layer.radius} min={0} max={2048} change={radius => patchLayer({radius})} />
          </div>
        </fieldset>}
      </aside>}
    </div>
  </section>;
}
