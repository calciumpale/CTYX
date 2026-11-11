'use client';

import { useState, type CSSProperties } from 'react';
import { ArrowUpRight, Layers3, Share2, Trash2 } from 'lucide-react';
import { BUILTIN_STUDIO_TEMPLATES } from '../lib/creative-studio-templates';
import { STUDIO_KINDS, STUDIO_KIND_LABELS, type StudioBoard, type StudioKind, type StudioTemplate } from '../lib/creative-studio-types';
import './studio-market.css';

interface StudioMarketProps {
  templates: StudioTemplate[];
  onChoose: (template: StudioTemplate) => void;
  onRemove: (template: StudioTemplate) => void;
  onPublish: () => void;
  canPublish: boolean;
  busy?: boolean;
  loading?: boolean;
  error?: string;
  onRetry: () => void;
}

function BoardPreview({ board }: { board?: StudioBoard }) {
  if (!board) return <span className="studio-market-preview" aria-hidden="true"><Layers3 size={26} /></span>;

  return <span className="studio-market-preview" aria-hidden="true">
    <span className="studio-market-artboard" style={{
      aspectRatio: board.width / board.height,
      backgroundColor: board.background,
      '--studio-market-board-ratio': board.width / board.height,
    } as CSSProperties}>
      {board.layers.filter(layer => layer.kind !== 'image').map(layer => (
        <span
          className={`studio-market-layer studio-market-layer-${layer.kind}`}
          key={layer.id}
          style={{
            left: `${layer.x}%`,
            top: `${layer.y}%`,
            width: `${layer.width}%`,
            height: `${layer.height}%`,
            backgroundColor: layer.fill,
            color: layer.color,
            fontSize: `${100 * layer.fontSize / board.width}cqw`,
            borderRadius: `${100 * layer.radius / board.width}cqw`,
            fontWeight: layer.weight,
            textAlign: layer.align,
          }}
        >{layer.kind !== 'shape' && layer.text}</span>
      ))}
    </span>
  </span>;
}

function TemplateCard({ template, busy, onChoose, onRemove }: Pick<StudioMarketProps, 'busy' | 'onChoose' | 'onRemove'> & { template: StudioTemplate }) {
  return <li className="studio-market-card">
    <button type="button" className="studio-market-pick" disabled={busy} onClick={() => onChoose(template)} aria-label={`使用模板 ${template.title}`}>
      <BoardPreview board={template.boards[0]} />
      <span className="studio-market-card-copy">
        <span className="studio-market-category">{STUDIO_KIND_LABELS[template.kind]}{template.boards.length > 1 && ` · ${template.boards.length} 个画板`}</span>
        <span className="studio-market-card-title"><strong>{template.title}</strong><ArrowUpRight size={16} aria-hidden="true" /></span>
        {template.description && <span className="studio-market-description">{template.description}</span>}
      </span>
    </button>
    {template.source === 'workspace' && template.canRemove && (
      <div className="studio-market-card-actions">
        <button type="button" className="button ghost" disabled={busy} aria-label={`移除共享模板 ${template.title}`} onClick={() => onRemove(template)}>
          <Trash2 size={14} aria-hidden="true" /> 移除
        </button>
      </div>
    )}
  </li>;
}

export default function StudioMarket({ templates, onChoose, onRemove, onPublish, canPublish, busy, loading, error, onRetry }: StudioMarketProps) {
  const [category, setCategory] = useState<StudioKind | 'all'>('all');
  const categories = ['all', ...STUDIO_KINDS] as const;
  const builtIn = BUILTIN_STUDIO_TEMPLATES.filter(template => category === 'all' || template.kind === category);
  const shared = templates.filter(template => template.source === 'workspace' && (category === 'all' || template.kind === category));

  return <section className="studio-market" aria-label="模板市场">
    <header className="studio-market-heading">
      <div>
        <h2>模板市场</h2>
        <p>选一个模板开始编辑，或把当前设计共享给工作空间成员。</p>
      </div>
      <button type="button" className="button secondary" onClick={onPublish} disabled={busy || !canPublish} title={!canPublish ? '请先打开要共享的设计' : undefined}>
        <Share2 size={15} aria-hidden="true" /> 发布当前设计
      </button>
    </header>
    <div className="studio-market-filters" role="group" aria-label="筛选模板类别">
      {categories.map(value => (
        <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)}>
          {value === 'all' ? '全部' : STUDIO_KIND_LABELS[value]}
        </button>
      ))}
    </div>
    <section className="studio-market-section" aria-label="工作台模板">
      <h3>工作台模板</h3>
      <ul className="studio-market-grid">
        {builtIn.map(template => <TemplateCard key={template.id} template={template} busy={busy} onChoose={onChoose} onRemove={onRemove} />)}
      </ul>
    </section>
    <section className="studio-market-section" aria-label="工作空间共享" aria-busy={loading || undefined}>
      <h3>工作空间共享</h3>
      {error && <div className="studio-market-status" role="alert">
        <span>{error}</span><button type="button" className="button secondary" disabled={busy} onClick={onRetry}>重试</button>
      </div>}
      {loading && <p className="studio-market-status" role="status">正在读取共享模板…</p>}
      {shared.length > 0
        ? <ul className="studio-market-grid">
          {shared.map(template => <TemplateCard key={template.id} template={template} busy={busy} onChoose={onChoose} onRemove={onRemove} />)}
        </ul>
        : !loading && !error && <p className="studio-market-status">{category === 'all' ? '暂无共享模板。' : `暂无${STUDIO_KIND_LABELS[category]}共享模板。`}</p>}
    </section>
  </section>;
}
