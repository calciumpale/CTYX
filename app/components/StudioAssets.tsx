'use client';

/* Material files are scoped to the signed-in member and bypass the public optimizer. */
/* eslint-disable @next/next/no-img-element */
import { Download, Film, Image, Layers3, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { PublicMaterialTask } from '../lib/marketing-material-types';
import type { StudioImage } from '../lib/creative-studio-types';

const labels = {
  submitting: '正在提交', submission_unknown: '提交结果待核对', queued: '排队中', processing: '生成中',
  saving: '保存中', completed: '已完成', failed: '生成失败', expired: '结果已过期',
};
const date = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
const refreshable = ['submitting', 'queued', 'processing', 'saving'];
const filters = [{ value: 'all', text: '全部' }, { value: 'image', text: '图片' }, { value: 'video', text: '视频' }] as const;
type Filter = typeof filters[number]['value'];

interface Props {
  tasks: PublicMaterialTask[];
  loading: boolean;
  busy: boolean;
  error: string;
  onReload: () => void;
  onRefresh: (task: PublicMaterialTask) => void;
  onUseImage?: (file: StudioImage) => void;
}

export default function StudioAssets({ tasks, loading, busy, error, onReload, onRefresh, onUseImage }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string>();
  const filtered = tasks.filter(task => task.input.kind !== 'presentation' && (filter === 'all' || task.input.kind === filter));
  const selected = filtered.find(task => task.id === selectedId);

  return <section className="creative-assets" aria-label="素材库">
    <div className="creative-collection-head">
      <div><h3>素材库</h3><p>查看已生成的图片、视频和进行中的素材任务。</p></div>
      <button type="button" disabled={busy || loading} onClick={onReload}><RefreshCw size={15} /> 刷新列表</button>
    </div>
    <div className="creative-filter" role="group" aria-label="素材类型">
      {filters.map(({ value, text }) => <button key={value} type="button" aria-pressed={filter === value}
        onClick={() => { setFilter(value); setSelectedId(undefined); }}>{text}</button>)}
    </div>
    {error && <p role="alert" className="material-error">{error}</p>}
    {loading && <p role="status">正在读取素材…</p>}
    {!loading && !error && filtered.length === 0 && <p>这里还没有{filter === 'all' ? '素材' : filter === 'image' ? '图片' : '视频'}。</p>}
    <div className={selected ? 'creative-assets-split' : undefined}>
      <ul className="creative-asset-grid">
        {filtered.map(task => {
          const isVideo = task.input.kind === 'video';
          const thumb = task.files.find(file => file.type.startsWith('image/'));
          const Icon = isVideo ? Film : Image;
          return <li key={task.id}>
            <button type="button" className="creative-asset-card" aria-pressed={selected?.id === task.id}
              onClick={() => setSelectedId(task.id)}>
              <span className="creative-asset-thumb" data-video={isVideo}>
                {thumb ? <img src={thumb.url} alt="" loading="lazy" /> : <Icon size={24} aria-hidden="true" />}
              </span>
              <strong>{task.input.prompt}</strong>
              <small>{labels[task.status]} · {date.format(new Date(task.createdAt))}</small>
            </button>
          </li>;
        })}
      </ul>
      {selected && <article className="creative-asset-detail" aria-label="素材详情">
        <div className="creative-collection-head">
          <div><h3>{selected.input.prompt}</h3><p>{labels[selected.status]}</p></div>
          <button type="button" onClick={() => setSelectedId(undefined)}>关闭详情</button>
        </div>
        {selected.error && <p role="status">{selected.error}</p>}
        {refreshable.includes(selected.status) && <div className="creative-asset-progress">
          <progress max={100} value={selected.progress} aria-label="素材任务进度" />
          <button type="button" disabled={busy || loading} onClick={() => onRefresh(selected)}>
            <RefreshCw size={15} /> {selected.status === 'saving' ? '重试保存' : '查询任务状态'}
          </button>
        </div>}
        {selected.files.map((file, index) => <div className="creative-asset-file" key={file.url}>
          {file.type.startsWith('image/')
            ? <img src={file.url} alt={`${selected.input.prompt} · 图片 ${index + 1}`} />
            : <video src={file.url} controls preload="metadata" aria-label={`${selected.input.prompt} · 视频`} />}
          <div className="creative-actions">
            <a href={file.url} download={file.name}><Download size={15} /> 下载{file.name}</a>
            {file.type.startsWith('image/') && onUseImage && <button type="button" disabled={busy} onClick={() => onUseImage(file)}>
              <Layers3 size={15} /> 添加到当前画板
            </button>}
          </div>
        </div>)}
      </article>}
    </div>
  </section>;
}
