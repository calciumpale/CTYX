'use client';

/* Cover results are authenticated, same-origin assets. */
/* eslint-disable @next/next/no-img-element */
import { CalendarPlus, Clapperboard, Clock3, Copy, Download, ImagePlus, PenLine, Sparkles, Trash2, Type } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { downloadStudioCopy, studioRequest } from '../lib/creative-studio-client';
import type { StudioCopy, StudioDocument, StudioImage, StudioShot } from '../lib/creative-studio-types';
import type { ScheduleDraft } from '../lib/schedule-types';
import './studio-content.css';

const channels = ['小红书', '抖音', '微信朋友圈', '公众号', '视频号', 'B站', '通用'];
const styles = ['自然口语', '简洁商务', '产品种草', '场景故事', '干货教程'];
interface Props {
  document: StudioDocument;
  onChange: (document: StudioDocument) => void;
  modelAvailable: boolean;
  busy: boolean;
  canDesign: boolean;
  canGenerateImage: boolean;
  needsSaveForImage: boolean;
  coverImage?: StudioImage;
  onGenerate: (instruction?: string) => void;
  onCreateDesign: () => void;
  onGenerateImage: () => void;
  onScheduleBusy: (busy: boolean) => void;
  notify: (message: string) => void;
}

export default function StudioContent({
  document, onChange, modelAvailable, busy, canDesign, canGenerateImage, needsSaveForImage,
  coverImage, onGenerate, onCreateDesign, onGenerateImage, onScheduleBusy, notify,
}: Props) {
  const contentId = useId();
  const titleId = `${contentId}-title`;
  const scheduleId = `${contentId}-schedule`;
  const [instruction, setInstruction] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [publishAt, setPublishAt] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const scheduleRequest = useRef({ key: '', id: '' });
  const scheduling = useRef(false);
  const copy = document.copy;
  const hasCopy = Boolean(copy.title || copy.caption || copy.script || copy.coverPrompt || copy.shots.length);
  const characterCount = Array.from((copy.script || copy.caption).trim()).length;
  const totalSeconds = copy.shots.reduce((total, shot) => total + shot.seconds, 0);
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
      notify('已添加到日程');
    } catch (error) {
      setScheduleError((error as Error).message);
    } finally {
      scheduling.current = false;
      onScheduleBusy(false);
    }
  }

  return <div className="studio-content">
    <div className="studio-content-layout">
      <aside className="studio-content-brief" aria-label="创作资料">
        <div className="studio-content-brief-fields">
          <h3><PenLine size={16} aria-hidden="true" /> 创作资料</h3>
          <label>灵感与产品资料
            <textarea rows={6} value={document.brief} maxLength={8000} disabled={busy}
              placeholder="记下一个灵感，或贴入产品资料、活动信息和必须保留的事实。"
              onChange={event => onChange({ ...document, brief: event.target.value })} />
          </label>
          <label>目标受众
            <input value={document.audience} maxLength={400} disabled={busy}
              onChange={event => onChange({ ...document, audience: event.target.value })} />
          </label>
          <div className="studio-content-selects">
            <label>发布平台<select value={document.channel} disabled={busy} onChange={event => onChange({ ...document, channel: event.target.value })}>
              {!channels.includes(document.channel) && <option>{document.channel}</option>}
              {channels.map(channel => <option key={channel}>{channel}</option>)}
            </select></label>
            <label>写作风格<select value={document.style} disabled={busy} onChange={event => onChange({ ...document, style: event.target.value })}>
              {!styles.includes(document.style) && <option>{document.style}</option>}
              {styles.map(style => <option key={style}>{style}</option>)}
            </select></label>
          </div>
        </div>
        <div className="studio-content-assistant">
          {hasCopy && <label>改稿要求
            <textarea rows={2} maxLength={1000} value={instruction} disabled={busy} placeholder="例如，开头先讲使用场景。"
              onChange={event => setInstruction(event.target.value)} />
          </label>}
          <button type="button" className="studio-content-ink" disabled={busy || !modelAvailable || !document.brief.trim()}
            onClick={() => onGenerate(instruction.trim() || undefined)}><Sparkles size={16} aria-hidden="true" /> {hasCopy ? '生成新版稿件' : '生成稿件'}</button>
          {!modelAvailable && <p role="status">大模型尚未启用。你可以先手动成稿。</p>}
        </div>
      </aside>

      <div className="studio-content-draft">
        <header className="studio-content-hero">
          <div className="studio-content-hero-copy">
            <h3 className="sr-only">营销稿件</h3>
            <div className="studio-content-title">
              <label htmlFor={titleId}>标题</label>
              <textarea id={titleId} rows={2} value={copy.title} maxLength={160} disabled={busy} placeholder="填写稿件标题"
                onChange={event => patchCopy({ title: event.target.value })} />
            </div>
            {(characterCount > 0 || copy.shots.length > 0) && <ul className="studio-content-metrics" aria-label="稿件信息">
              {characterCount > 0 && <li><Type size={13} aria-hidden="true" /> {characterCount} 字</li>}
              {copy.shots.length > 0 && <li><Clapperboard size={13} aria-hidden="true" /> {copy.shots.length} 镜</li>}
              {totalSeconds > 0 && <li><Clock3 size={13} aria-hidden="true" /> {totalSeconds} 秒</li>}
            </ul>}
            <div className="studio-content-actions">
              <button type="button" className="studio-content-ink" disabled={!copy.script}
                aria-label="复制口播脚本" onClick={() => void copyText(copy.script)}><Copy size={15} aria-hidden="true" /> 复制脚本</button>
              <button type="button" disabled={!hasCopy || busy} onClick={() => downloadStudioCopy(document)}><Download size={15} aria-hidden="true" /> 下载稿件</button>
              <button type="button" disabled={!hasCopy || busy} onClick={() => setScheduleOpen(value => !value)}
                aria-expanded={scheduleOpen} aria-controls={scheduleOpen ? scheduleId : undefined}><CalendarPlus size={15} aria-hidden="true" /> 排期</button>
              <button type="button" disabled={!canDesign || !copy.title.trim() || busy} onClick={onCreateDesign}>用稿件做画板</button>
            </div>
          </div>
          <div className="studio-content-cover">
            {coverImage && <img className="studio-content-cover-image" src={coverImage.url} alt={coverImage.name || '已生成的封面'} />}
            <label>封面构思
              <textarea rows={coverImage ? 2 : 3} value={copy.coverPrompt} maxLength={1800} disabled={busy}
                placeholder="描述画面主体、构图和色彩" onChange={event => patchCopy({ coverPrompt: event.target.value })} />
            </label>
            <div className="studio-content-actions">
              <button type="button" disabled={!copy.coverPrompt} aria-label="复制封面构思" onClick={() => void copyText(copy.coverPrompt)}><Copy size={14} aria-hidden="true" /> 复制</button>
              <button type="button" disabled={busy || !canGenerateImage || !copy.coverPrompt.trim()}
                onClick={onGenerateImage}><ImagePlus size={15} aria-hidden="true" /> 生成封面图片</button>
            </div>
            {needsSaveForImage && copy.coverPrompt.trim() && <p>保存项目后即可生成封面图片。</p>}
          </div>
        </header>
        {scheduleOpen && <form id={scheduleId} className="studio-content-schedule" onSubmit={event => { event.preventDefault(); void schedule(); }}>
          <label>发布时间（北京时间）<input type="datetime-local" value={publishAt} onChange={event => setPublishAt(event.target.value)} required disabled={busy} /></label>
          <button type="submit" className="studio-content-ink" disabled={busy || !publishAt}>加入日程</button>
          {scheduleError && <p className="material-error" role="alert">{scheduleError}</p>}
        </form>}
        <div className="studio-content-lower">
          <section className="studio-content-script" aria-label="口播脚本和发布文案">
            <label>口播脚本
              <textarea rows={8} value={copy.script} maxLength={6000} disabled={busy}
                placeholder="填写可直接录制的口播脚本" onChange={event => patchCopy({ script: event.target.value })} />
            </label>
            <div className="studio-content-caption">
              <label>发布文案
                <textarea rows={4} value={copy.caption} maxLength={4000} disabled={busy}
                  placeholder="填写发布时随素材一起展示的文案" onChange={event => patchCopy({ caption: event.target.value })} />
              </label>
              <button type="button" disabled={!copy.caption} aria-label="复制发布文案" onClick={() => void copyText(copy.caption)}><Copy size={14} aria-hidden="true" /> 复制</button>
            </div>
          </section>
          <section className="studio-content-storyboard" aria-label="视频分镜">
            <div className="studio-content-panel-heading">
              <h3><Clapperboard size={16} aria-hidden="true" /> 视频分镜</h3>
              <button type="button" disabled={busy || copy.shots.length >= 12}
                onClick={() => patchCopy({ shots: [...copy.shots, { visual: '', voiceover: '', seconds: 5 }] })}>添加分镜</button>
            </div>
            {copy.shots.length === 0 && <p>可手动添加分镜，或从产品资料生成一组。</p>}
            {copy.shots.length > 0 && <ol className="studio-content-shots">
              {copy.shots.map((shot, index) => <li key={index} aria-label={`第 ${index + 1} 镜`}>
                <div className="studio-content-shot-heading">
                  <strong>第 {index + 1} 镜</strong>
                  <button type="button" disabled={busy} aria-label={`移除第 ${index + 1} 镜`}
                    onClick={() => patchCopy({ shots: copy.shots.filter((_, position) => position !== index) })}><Trash2 size={14} aria-hidden="true" /></button>
                </div>
                <label className="studio-content-shot-visual">画面
                  <textarea aria-label="画面" rows={3} value={shot.visual} maxLength={500} disabled={busy} onChange={event => patchShot(index, { visual: event.target.value })} />
                </label>
                <label>口播
                  <textarea aria-label="口播" rows={2} value={shot.voiceover} maxLength={500} disabled={busy} onChange={event => patchShot(index, { voiceover: event.target.value })} />
                </label>
                <label className="studio-content-duration">时长（秒）
                  <input type="number" min={1} max={120} value={shot.seconds} disabled={busy}
                    onChange={event => patchShot(index, { seconds: Math.min(120, Math.max(1, Math.round(Number(event.target.value)))) })} />
                </label>
              </li>)}
            </ol>}
          </section>
        </div>
      </div>
    </div>
  </div>;
}
