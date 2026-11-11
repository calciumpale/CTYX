'use client';

import { CalendarPlus, Clapperboard, Copy, Download, ImagePlus, PenLine, Sparkles, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { downloadStudioCopy, studioRequest } from '../lib/creative-studio-client';
import type { StudioCopy, StudioDocument, StudioShot } from '../lib/creative-studio-types';
import type { ScheduleDraft } from '../lib/schedule-types';

const channels = ['小红书', '抖音', '微信朋友圈', '公众号', '视频号', 'B站', '通用'];
const styles = ['自然口语', '简洁商务', '产品种草', '场景故事', '干货教程'];
const textFields = [
  { key: 'title', label: '标题', max: 160 },
  { key: 'caption', label: '发布文案', max: 4000 },
  { key: 'script', label: '口播脚本', max: 6000 },
  { key: 'coverPrompt', label: '封面构思', max: 1800 },
] as const;

interface Props {
  document: StudioDocument;
  onChange: (document: StudioDocument) => void;
  modelAvailable: boolean;
  busy: boolean;
  canDesign: boolean;
  canGenerateImage: boolean;
  needsSaveForImage: boolean;
  onGenerate: (instruction?: string) => void;
  onCreateDesign: () => void;
  onGenerateImage: () => void;
  onScheduleBusy: (busy: boolean) => void;
  notify: (message: string) => void;
}

export default function StudioContent({
  document, onChange, modelAvailable, busy, canDesign, canGenerateImage, needsSaveForImage,
  onGenerate, onCreateDesign, onGenerateImage, onScheduleBusy, notify,
}: Props) {
  const [instruction, setInstruction] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [publishAt, setPublishAt] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const scheduleRequest = useRef({ key: '', id: '' });
  const scheduling = useRef(false);
  const copy = document.copy;
  const hasCopy = Boolean(copy.title || copy.caption || copy.script || copy.coverPrompt || copy.shots.length);
  const patchCopy = (patch: Partial<StudioCopy>) => onChange({ ...document, copy: { ...copy, ...patch } });
  function patchShot(index: number, patch: Partial<StudioShot>) {
    patchCopy({ shots: copy.shots.map((shot, position) => position === index ? { ...shot, ...patch } : shot) });
  }
  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify('已复制');
    } catch {
      notify('无法访问剪贴板，可以选中文案手动复制。');
    }
  }
  async function schedule() {
    if (scheduling.current || !publishAt || busy) return;
    const start = Date.parse(`${publishAt}:00+08:00`);
    if (!Number.isFinite(start)) {
      setScheduleError('请选择有效的发布时间。');
      return;
    }
    const draft: ScheduleDraft = {
      kind: 'task', title: `发布素材 · ${document.title}`.slice(0, 120),
      startAt: new Date(start).toISOString(), endAt: new Date(start + 30 * 60000).toISOString(),
      allDay: false, dealId: null, location: document.channel, notes: (copy.caption || copy.title).slice(0, 4000),
    };
    const key = JSON.stringify(draft);
    if (scheduleRequest.current.key !== key) scheduleRequest.current = { key, id: crypto.randomUUID() };
    scheduling.current = true;
    onScheduleBusy(true);
    setScheduleError('');
    try {
      await studioRequest('', { action: 'create', requestId: scheduleRequest.current.id, draft }, '/api/schedules');
      setScheduleOpen(false);
      notify('已添加到提醒及日程');
    } catch (error) {
      setScheduleError((error as Error).message);
    } finally {
      scheduling.current = false;
      onScheduleBusy(false);
    }
  }

  return <div className="creative-content">
    <aside className="creative-brief" aria-label="创作资料">
      <h3><PenLine size={17} /> 创作资料</h3>
      <label>灵感与产品资料
        <textarea rows={7} value={document.brief} maxLength={8000} disabled={busy}
          placeholder="记下一个灵感，或贴入产品资料、活动信息和必须保留的事实。"
          onChange={event => onChange({ ...document, brief: event.target.value })} />
      </label>
      <label>目标受众
        <input value={document.audience} maxLength={400} disabled={busy} onChange={event => onChange({ ...document, audience: event.target.value })} />
      </label>
      <div className="creative-field-pair">
        <label>发布平台<select value={document.channel} disabled={busy} onChange={event => onChange({ ...document, channel: event.target.value })}>
          {!channels.includes(document.channel) && <option>{document.channel}</option>}
          {channels.map(channel => <option key={channel}>{channel}</option>)}
        </select></label>
        <label>写作风格<select value={document.style} disabled={busy} onChange={event => onChange({ ...document, style: event.target.value })}>
          {!styles.includes(document.style) && <option>{document.style}</option>}
          {styles.map(style => <option key={style}>{style}</option>)}
        </select></label>
      </div>
      {hasCopy && <label>改稿要求
        <textarea rows={2} maxLength={1000} value={instruction} disabled={busy} placeholder="例如，开头先讲使用场景。"
          onChange={event => setInstruction(event.target.value)} />
      </label>}
      <button type="button" className="creative-primary" disabled={busy || !modelAvailable || !document.brief.trim()}
        onClick={() => onGenerate(instruction.trim() || undefined)}><Sparkles size={16} /> {hasCopy ? '生成新版稿件' : '生成稿件'}</button>
      {!modelAvailable && <p role="status">大模型尚未启用。你可以先手动成稿。</p>}
    </aside>
    <div className="creative-copy">
      <div className="creative-section-title">
        <h3>营销稿件</h3>
        <div className="creative-actions">
          <button type="button" disabled={!hasCopy || busy} onClick={() => downloadStudioCopy(document)}><Download size={16} /> 下载稿件</button>
          <button type="button" disabled={!hasCopy || busy} onClick={() => setScheduleOpen(value => !value)} aria-expanded={scheduleOpen}><CalendarPlus size={16} /> 排期</button>
          <button type="button" disabled={!canDesign || !copy.title.trim() || busy} onClick={onCreateDesign}>用稿件做画板</button>
        </div>
      </div>
      {scheduleOpen && <form className="creative-schedule" onSubmit={event => { event.preventDefault(); void schedule(); }}>
        <label>发布时间（北京时间）<input type="datetime-local" value={publishAt} onChange={event => setPublishAt(event.target.value)} required disabled={busy} /></label>
        <button type="submit" disabled={busy || !publishAt}>加入日程</button>
        {scheduleError && <p className="material-error" role="alert">{scheduleError}</p>}
      </form>}
      {textFields.map(({ key, label, max }) => <div className="creative-copy-field" key={key}>
        <label>
          {label}
          {key === 'title'
            ? <input value={copy[key]} maxLength={max} disabled={busy} onChange={event => patchCopy({ [key]: event.target.value })} />
            : <textarea rows={key === 'script' ? 5 : 3} value={copy[key]} maxLength={max} disabled={busy}
              onChange={event => patchCopy({ [key]: event.target.value })} />}
        </label>
        <div className="creative-actions">
          <button type="button" disabled={!copy[key]} aria-label={`复制${label}`} onClick={() => void copyText(copy[key])}><Copy size={15} /> 复制</button>
          {key === 'coverPrompt' && <button type="button" disabled={busy || !canGenerateImage || !copy.coverPrompt.trim()}
            onClick={onGenerateImage}><ImagePlus size={16} /> 生成封面图片</button>}
        </div>
        {key === 'coverPrompt' && needsSaveForImage && copy.coverPrompt.trim() && <p>保存项目后即可生成封面图片。</p>}
      </div>)}
      <div className="creative-section-title">
        <h3><Clapperboard size={17} /> 视频分镜</h3>
        <button type="button" disabled={busy || copy.shots.length >= 12}
          onClick={() => patchCopy({ shots: [...copy.shots, { visual: '', voiceover: '', seconds: 5 }] })}>添加分镜</button>
      </div>
      {copy.shots.length === 0 && <p>可手动添加分镜，或从产品资料生成一组。</p>}
      <ol className="creative-shots">
        {copy.shots.map((shot, index) => <li key={index}>
          <div className="creative-section-title"><strong>第 {index + 1} 镜</strong><button type="button"
            disabled={busy} aria-label={`移除第 ${index + 1} 镜`}
            onClick={() => patchCopy({ shots: copy.shots.filter((_, position) => position !== index) })}><Trash2 size={15} /></button></div>
          <label>画面<textarea rows={2} value={shot.visual} maxLength={500} disabled={busy} onChange={event => patchShot(index, { visual: event.target.value })} /></label>
          <label>口播<textarea rows={2} value={shot.voiceover} maxLength={500} disabled={busy} onChange={event => patchShot(index, { voiceover: event.target.value })} /></label>
          <label>时长（秒）<input type="number" min={1} max={120} value={shot.seconds} disabled={busy}
            onChange={event => patchShot(index, { seconds: Math.min(120, Math.max(1, Math.round(Number(event.target.value)))) })} /></label>
        </li>)}
      </ol>
    </div>
  </div>;
}
