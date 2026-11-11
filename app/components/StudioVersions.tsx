'use client';

import { ArrowDownToLine, GitCompareArrows } from 'lucide-react';
import { useEffect, useState } from 'react';
import { studioRequest } from '../lib/creative-studio-client';
import type { StudioDocument, StudioImage, StudioRecord, StudioVersion } from '../lib/creative-studio-types';
import { BoardPreview } from './StudioCanvas';

const timestamp = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai',
});

interface Props {
  id: string;
  document: StudioDocument;
  versions: StudioVersion[];
  images: StudioImage[];
  disabled: boolean;
  onRestore: (document: StudioDocument) => void;
}

function VersionSide({ id, label, selected, onSelect, document, versions, images, disabled, onRestore }: Props & {
  label: string;
  selected: string;
  onSelect: (selection: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<StudioRecord>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [boardIndex, setBoardIndex] = useState(0);
  const targetVersion = selected === 'draft' ? undefined : Number(selected);
  const current = targetVersion === undefined ? document : snapshot?.version === targetVersion ? snapshot.document : undefined;
  const board = current?.boards[boardIndex] ?? current?.boards[0];

  useEffect(() => {
    if (targetVersion === undefined) return;
    let active = true;
    void studioRequest<{ project: StudioRecord }>(`?id=${encodeURIComponent(id)}&version=${targetVersion}`)
      .then(data => { if (active) { setSnapshot(data.project); setError(''); } })
      .catch(error => { if (active) setError((error as Error).message); });
    return () => { active = false; };
  }, [id, targetVersion, attempt]);

  return <section className="creative-version-side" aria-label={label}>
    <div className="creative-section-title">
      <label>{label}<select value={selected} disabled={disabled} onChange={event => {
        setError('');
        setBoardIndex(0);
        onSelect(event.target.value);
      }}>
        <option value="draft">当前草稿</option>
        {versions.map(version => <option key={version.version} value={version.version}>
          版本 {version.version} · {timestamp.format(new Date(version.updatedAt))}
        </option>)}
      </select></label>
      {targetVersion !== undefined && current && <button type="button" disabled={disabled} onClick={() => onRestore(current)}>
        <ArrowDownToLine size={16} /> 恢复为草稿
      </button>}
    </div>
    {error && <p className="material-error" role="alert">{error} <button type="button" onClick={() => { setError(''); setAttempt(value => value + 1); }}>重试</button></p>}
    {!current && !error && <p role="status">正在读取版本…</p>}
    {current && <>
      {current.boards.length > 1 && <label>预览画板
        <select value={boardIndex} onChange={event => setBoardIndex(Number(event.target.value))}>
          {current.boards.map((item, index) => <option key={item.id} value={index}>{item.name}</option>)}
        </select>
      </label>}
      {board && <div className="creative-version-art"><BoardPreview board={board} images={images} maxWidth={430} maxHeight={440} /></div>}
      <details className="creative-version-copy" open>
        <summary>稿件与资料</summary>
        <dl>
          <dt>项目名称</dt><dd>{current.title}</dd>
          <dt>创作资料</dt><dd>{current.brief || '—'}</dd>
          <dt>标题</dt><dd>{current.copy.title || '—'}</dd>
          <dt>文案</dt><dd>{current.copy.caption || '—'}</dd>
          <dt>脚本</dt><dd>{current.copy.script || '—'}</dd>
          <dt>分镜</dt><dd>{current.copy.shots.length ? current.copy.shots.map((shot, index) =>
            `${index + 1}. ${shot.seconds} 秒 · ${shot.visual}\n${shot.voiceover}`).join('\n\n') : '—'}</dd>
        </dl>
      </details>
    </>}
  </section>;
}

export default function StudioVersions(props: Props) {
  const [left, setLeft] = useState(String(props.versions[1]?.version ?? props.versions[0]?.version ?? 'draft'));
  const [right, setRight] = useState('draft');
  return <div className="creative-versions">
    <div className="creative-section-title"><h3><GitCompareArrows size={18} /> 版本比较</h3></div>
    {!props.versions.length ? <p>保存项目后，即可查看和对比历史版本。</p> : <div className="creative-version-grid">
      <VersionSide {...props} label="左侧版本" selected={left} onSelect={setLeft} />
      <VersionSide {...props} label="右侧版本" selected={right} onSelect={setRight} />
    </div>}
  </div>;
}
