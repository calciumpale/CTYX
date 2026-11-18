'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Archive, BadgeCheck, CalendarDays, Check, Clipboard, Download, FileText, Image, ListPlus, Loader2, Plus, RefreshCw, Sparkles, Trash2, Users, Video } from 'lucide-react';
import { Overlay } from './CoreViews';
import { CreativeCanvasIllustration } from './VisualIllustrations';
import { preferredScrollBehavior } from '../lib/scroll-behavior';
import type FactoryHistory from './FactoryHistory';
import { studioColor, studioLayerStyle } from '../lib/creative-studio-geometry';
import type { StudioBoard } from '../lib/creative-studio-types';
import {
  blankFactoryDocument, FACTORY_CHANNELS, FACTORY_GOALS, FACTORY_TONES,
  type FactoryBrief, type FactoryChannel, type FactoryCopy, type FactoryDocument, type FactoryGeneration, type FactoryQueueItem, type FactoryRecord,
} from '../lib/content-factory-types';
import './content-factory.css';

type Operation = 'generate' | 'save' | 'export';
type Props = { notify: (message: string) => void; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void };
type GenerationResponse = { generated: FactoryGeneration; posterError?: string; copyError?: string };
const endpoint = '/api/content-factory';
const channels = Object.keys(FACTORY_CHANNELS) as FactoryChannel[];
const safeFile = (name: string) => name.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80) || '海报';
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

async function callFactory<T>(body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store', signal });
  const result = await response.json().catch(() => null) as (T & { message?: string; error?: string }) | null;
  if (!response.ok || !result) {
    throw new Error(result?.message || result?.error || '内容工厂暂时无法连接，请稍后重试。');
  }
  return result;
}

export default function ContentFactory({ notify, onBusyChange, onDirtyChange }: Props) {
  const [campaigns, setCampaigns] = useState<FactoryRecord[]>([]);
  const [current, setCurrent] = useState<FactoryRecord | null>(null);
  const [document, setDocument] = useState<FactoryDocument>(blankFactoryDocument);
  const [ready, setReady] = useState<boolean | null>(null);
  const [reading, setReading] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [resultTab, setResultTab] = useState<FactoryChannel>('wechat');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [History, setHistory] = useState<typeof FactoryHistory | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState('');
  const [scheduleDate, setScheduleDate] = useState('');
  const [replaceTarget, setReplaceTarget] = useState<string | null>(null);
  const [preview, setPreview] = useState<StudioBoard | null>(null);
  const generationInFlight = useRef(false);
  const campaignRead = useRef<AbortController | null>(null);
  const campaignWriteRevision = useRef(0);
  const channelResults = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const channelIds = useId();
  const reviewNoteId = useId();
  const [scheduleError, setScheduleError] = useState('');
  const saveId = useRef('');
  const { brief, generated, queue } = document;
  const changed = JSON.stringify(document) !== JSON.stringify(current?.document ?? blankFactoryDocument());
  const busy = operation !== null;
  const availableTabs = channels.filter(channel => brief.channels.includes(channel) || generated?.copy.some(item => item.channel === channel) || channel === 'poster' && generated?.posters.length);
  const active = availableTabs.includes(resultTab) ? resultTab : availableTabs[0];
  const copy = generated?.copy.find(item => item.channel === active);
  const showPosters = active === 'poster' && Boolean(generated?.posters.length);
  const canGenerateActive = active && brief.topic.trim() && brief.channels.includes(active) && ready !== false;

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(changed); }, [changed, onDirtyChange]);
  const refresh = useCallback(async () => {
    campaignRead.current?.abort();
    const read = new AbortController();
    campaignRead.current = read;
    const revision = campaignWriteRevision.current;
    setReading(true);
    setLoadError('');
    try {
      const result = await callFactory<{ modelAvailable: boolean; campaigns: FactoryRecord[] }>(undefined, read.signal);
      if (read.signal.aborted) return;
      if (revision === campaignWriteRevision.current) setCampaigns(result.campaigns);
      setReady(result.modelAvailable);
    } catch (reason) {
      if (!read.signal.aborted) setLoadError(reason instanceof Error ? reason.message : '无法读取历史活动。');
    } finally {
      if (!read.signal.aborted) setReading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      campaignRead.current?.abort();
    };
  }, [refresh]);
  useEffect(() => () => { onBusyChange?.(false); onDirtyChange?.(false); }, [onBusyChange, onDirtyChange]);

  async function openHistory() {
    setHistoryOpen(true);
    setHistoryError('');
    if (History) return;
    try {
      const module = await import('./FactoryHistory');
      if (mounted.current) setHistory(() => module.default);
    } catch {
      if (mounted.current) setHistoryError('历史素材加载失败，请重试。');
    }
  }

  function selectResultFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, channel: FactoryChannel) {
    const index = availableTabs.indexOf(channel);
    const last = availableTabs.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = index === 0 ? last : index - 1; break;
      case 'ArrowRight': next = index === last ? 0 : index + 1; break;
      case 'Home': next = 0; break;
      case 'End': next = last; break;
      default: return;
    }
    event.preventDefault();
    setResultTab(availableTabs[next]);
    const tabs = event.currentTarget.parentElement;
    const tab = tabs?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next];
    if (tab && tabs) {
      tab.focus({ preventScroll: true });
      const bounds = tab.getBoundingClientRect();
      const strip = tabs.getBoundingClientRect();
      if (bounds.left < strip.left) tabs.scrollLeft -= strip.left - bounds.left;
      if (bounds.right > strip.right) tabs.scrollLeft += bounds.right - strip.right;
    }
  }

  function updateBrief<K extends keyof FactoryBrief>(key: K, value: FactoryBrief[K]) {
    setDocument(item => ({ ...item, brief: { ...item.brief, [key]: value } }));
  }

  function selectCampaign(id: string) {
    const record = campaigns.find(item => item.id === id) ?? null;
    setCurrent(record);
    setDocument(record?.document ?? blankFactoryDocument());
    setResultTab(record?.document.brief.channels[0] ?? 'wechat');
    saveId.current = '';
    setError('');
    setReplaceTarget(null);
  }

  function openCampaign(id: string) {
    if (changed) setReplaceTarget(id);
    else selectCampaign(id);
  }

  async function generate(channel?: FactoryChannel) {
    if (generationInFlight.current || busy) return;
    if (!brief.topic.trim() || !brief.channels.length || (channel && !brief.channels.includes(channel))) {
      setError('请填写活动主题并选择需要生成的渠道。');
      return;
    }
    generationInFlight.current = true;
    setOperation('generate');
    setError('');
    try {
      const previous = generated?.copy.find(item => item.channel === channel)?.body;
      const result = await callFactory<GenerationResponse>({ action: 'generate', brief, ...(channel ? { channel, previous } : {}) });
      setDocument(item => {
        const incoming = result.generated;
        const original = item.generated;
        if (!original) return { ...item, generated: incoming };
        if (!channel) return { ...item, generated: {
          ...incoming,
          copy: result.copyError ? [
            ...incoming.copy,
            ...original.copy.filter(entry => brief.channels.includes(entry.channel) && !incoming.copy.some(draft => draft.channel === entry.channel)),
          ] : incoming.copy,
          posters: result.posterError ? original.posters : incoming.posters,
          audience: incoming.audience,
        } };
        return { ...item, generated: {
          ...original, generatedAt: incoming.generatedAt,
          copy: channel === 'poster' ? original.copy : [...original.copy.filter(entry => entry.channel !== channel), ...incoming.copy],
          posters: channel === 'poster' ? incoming.posters : original.posters,
        } };
      });
      if (!channel) setResultTab(result.generated.copy[0]?.channel ?? (result.generated.posters.length ? 'poster' : brief.channels[0]));
      setError([result.copyError, result.posterError].filter(Boolean).join(' '));
      if (!result.copyError && !result.posterError) notify(channel ? '新版草稿已生成' : '草稿已生成');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成失败，请重试。');
    } finally {
      generationInFlight.current = false;
      setOperation(null);
    }
  }

  async function save(next: FactoryDocument = document, asNew = false) {
    if (busy) return false;
    setOperation('save');
    setError('');
    if (!saveId.current) saveId.current = crypto.randomUUID();
    try {
      const result = await callFactory<{ record: FactoryRecord }>({
        action: 'save', id: asNew ? crypto.randomUUID() : current?.id ?? saveId.current,
        version: asNew ? 0 : current?.version ?? 0, document: next,
      });
      const record = result.record;
      campaignWriteRevision.current += 1;
      setCurrent(record);
      setDocument(record.document);
      setCampaigns(items => [record, ...items.filter(item => item.id !== record.id)].slice(0, 20));
      notify('活动已保存');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '活动保存失败，请重试。');
      return false;
    } finally {
      setOperation(null);
    }
  }

  function updateCopy(channel: FactoryChannel, field: 'title' | 'alternateTitle' | 'body', value: string) {
    setDocument(item => item.generated ? {
      ...item,
      generated: { ...item.generated, copy: item.generated.copy.map(draft => draft.channel === channel ? { ...draft, [field]: value } : draft) },
    } : item);
  }

  function addToQueue(asset: Omit<FactoryQueueItem, 'id' | 'status' | 'scheduledAt'>) {
    if (queue.length >= 60) { setError('当前活动的发布队列最多可加入 60 条内容。'); return; }
    const same = queue.some(item => item.channel === asset.channel && item.assetId === asset.assetId &&
      item.title === asset.title && item.body === asset.body && JSON.stringify(item.poster) === JSON.stringify(asset.poster));
    if (same) { setQueueOpen(true); return; }
    setDocument(item => ({ ...item, queue: [...item.queue, { ...asset, id: crypto.randomUUID(), status: 'draft', scheduledAt: '' }] }));
    notify('已加入发布队列草稿');
  }

  function openReview(id = '') {
    const item = queue.find(entry => entry.id === id);
    const instant = item?.scheduledAt ? new Date(item.scheduledAt) : null;
    const local = instant && Number.isFinite(instant.valueOf())
      ? new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
      : '';
    setReviewTarget(id);
    setScheduleDate(local);
    setScheduleError('');
    setError('');
    setReviewOpen(true);
  }

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const chosen = queue.filter(item => (reviewTarget ? item.id === reviewTarget : item.status === 'draft'));
    if (!chosen.length) return;
    const date = scheduleDate ? new Date(scheduleDate) : null;
    if (date && (!Number.isFinite(date.valueOf()) || date.valueOf() <= Date.now())) {
      setScheduleError('请选择未来的排期时间。');
      return;
    }
    const next: FactoryDocument = {
      ...document,
      queue: queue.map(item => chosen.some(entry => entry.id === item.id)
        ? { ...item, status: item.status === 'approved' ? 'approved' : date ? 'scheduled' : 'review', scheduledAt: date?.toISOString() ?? '' }
        : item),
    };
    if (await save(next)) {
      setReviewOpen(false);
      setQueueOpen(true);
    }
  }

  async function copyText(draft: FactoryCopy) {
    try {
      await navigator.clipboard.writeText([draft.title, draft.body].filter(Boolean).join('\n\n'));
      notify('文案已复制');
    } catch {
      setError('浏览器未允许复制，请在文案框内手动选中复制。');
    }
  }

  async function exportPoster(board: StudioBoard) {
    setOperation('export');
    setError('');
    try {
      const { downloadStudioBlob, renderStudioBoardPng } = await import('../lib/creative-studio-export');
      downloadStudioBlob(await renderStudioBoardPng(board), `${safeFile(board.name)}.png`);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '海报导出失败。'); }
    finally { setOperation(null); }
  }

  async function exportAll(boards: StudioBoard[]) {
    setOperation('export');
    setError('');
    try {
      const [{ downloadStudioBlob, renderStudioBoardPng }, { zip }] = await Promise.all([
        import('../lib/creative-studio-export'), import('fflate'),
      ]);
      const files: Record<string, Uint8Array> = {};
      for (let index = 0; index < boards.length; index++) {
        const board = boards[index];
        const png = await renderStudioBoardPng(board);
        files[`${index + 1}-${safeFile(board.name)}.png`] = new Uint8Array(await png.arrayBuffer());
      }
      const archive = await new Promise<Uint8Array>((resolve, reject) => {
        zip(files, { level: 0 }, (error, data) => error ? reject(error) : resolve(data));
      });
      downloadStudioBlob(new Blob([Uint8Array.from(archive)], { type: 'application/zip' }), `${safeFile(brief.topic)}-海报.zip`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '海报导出失败。');
    } finally {
      setOperation(null);
    }
  }

  const statusText = { draft: '草稿', review: '待审核', scheduled: '待审核 · 已登记排期', approved: '已审核' };
  const canQueueCopy = Boolean(copy?.title.trim() && copy.body.trim());
  const hasDrafts = queue.some(item => item.status === 'draft');

  return <div className="cf">
    <div className="cf-toolbar" role="group" aria-label="活动管理">
      <div className="cf-actions cf-toolbar-history">
        {campaigns.length > 0 && <select className="cf-history" aria-label="历史活动" disabled={busy} value={current?.id ?? ''} onChange={event => openCampaign(event.target.value)}>
          <option value="">历史活动</option>{campaigns.map(item => <option key={item.id} value={item.id}>{item.document.brief.topic || '未命名活动'}</option>)}
        </select>}
        {current && <button className="button ghost" disabled={busy} onClick={() => openCampaign('')}><Plus size={15} />新建活动</button>}
        <button className="button ghost" disabled={busy} onClick={() => void openHistory()}><Archive size={15} />历史素材</button>
      </div>
      <div className="cf-actions cf-toolbar-publish">
        <button className="button secondary" disabled={busy || !changed} onClick={() => void save()}>保存活动</button>
        <button className="button secondary" disabled={busy} onClick={() => setQueueOpen(true)}><ListPlus size={16} />发布队列{queue.length ? ` · ${queue.length}` : ''}</button>
        <button className="button primary" disabled={busy || !hasDrafts} onClick={() => openReview()}><CalendarDays size={16} />送审并排期</button>
      </div>
    </div>
    {loadError && <div className="cf-feedback" role="alert">{loadError} <button className="button ghost" disabled={reading || busy} onClick={() => void refresh()}>重新读取</button></div>}
    {error && !reviewOpen && !queueOpen && !preview && <div className="cf-feedback" role="alert">{error}{error.includes('新版本') && <button className="button secondary" disabled={busy} onClick={() => void save(document, true)}>另存当前草稿</button>}</div>}
    <div className="cf-grid">
      <form className="cf-brief cf-panel" onSubmit={event => { event.preventDefault(); void generate(); }}>
        <div className="cf-panel-head"><h3><Sparkles size={16} />创作配置</h3></div>
        <div className="cf-fields">
          <fieldset className="cf-field cf-wide" disabled={busy}><legend>营销目标</legend>
            <div className="cf-chips">{Object.entries(FACTORY_GOALS).map(([value, label]) =>
              <button key={value} type="button" className="button secondary" aria-pressed={brief.goal === value} onClick={() => updateBrief('goal', value as FactoryBrief['goal'])}>{label}</button>)}</div>
          </fieldset>
          <label className="cf-field cf-wide">活动 / 主题<input value={brief.topic} placeholder="例如：园区开放日邀约" maxLength={160} disabled={busy} required onChange={event => updateBrief('topic', event.target.value)} /></label>
          <label className="cf-field">目标人群<input value={brief.audience} placeholder="你想触达谁？" maxLength={500} disabled={busy} onChange={event => updateBrief('audience', event.target.value)} /></label>
          <label className="cf-field">语气风格<select value={brief.tone} disabled={busy} onChange={event => updateBrief('tone', event.target.value as FactoryBrief['tone'])}>
            {Object.entries(FACTORY_TONES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <fieldset className="cf-field cf-wide cf-channels" disabled={busy}><legend>投放渠道 <span>可多选</span></legend>
            <div className="cf-chips">{channels.map(channel =>
              <button key={channel} type="button" className="button secondary" aria-pressed={brief.channels.includes(channel)}
                onClick={() => updateBrief('channels', brief.channels.includes(channel) ? brief.channels.filter(item => item !== channel) : [...brief.channels, channel])}>{FACTORY_CHANNELS[channel]}</button>)}</div>
          </fieldset>
          <label className="cf-field cf-wide">品牌 / 产品<input value={brief.brand} placeholder="填写品牌名或活动方" maxLength={180} disabled={busy} onChange={event => updateBrief('brand', event.target.value)} /></label>
          <label className="cf-field cf-wide">补充要求<textarea rows={3} value={brief.requirements} placeholder="可用事实、品牌用语、字数限制或活动规则" maxLength={6000} disabled={busy} onChange={event => updateBrief('requirements', event.target.value)} /></label>
        </div>
        <div className="cf-generate">
          <button className="button primary" type="submit" disabled={busy || ready === false || !brief.topic.trim() || !brief.channels.length}>
            {operation === 'generate' ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}生成全套内容
          </button>
          {generated && <button className="button secondary cf-view-results" type="button" onClick={() => {
            channelResults.current?.focus({ preventScroll: true });
            channelResults.current?.scrollIntoView({ block: 'start', behavior: preferredScrollBehavior() });
          }}>查看生成结果</button>}
          {ready === false && <p>请先在服务连接中配置并启用大模型。 <button type="button" className="button ghost" disabled={reading || busy} onClick={() => void refresh()}>刷新连接状态</button></p>}
          {operation === 'generate' && <p role="status">正在生成所选渠道的内容…</p>}
        </div>
      </form>
      <div className="cf-output">
        <section className="cf-results cf-panel" ref={channelResults} tabIndex={-1} aria-label="渠道文案">
          <div className="cf-panel-head">
            <div><h3><FileText size={16} />渠道文案</h3>{generated && <p>{generated.copy.length} 份文案 · {generated.posters.length} 版海报 · 最近生成 {dateLabel(generated.generatedAt)}</p>}</div>
            {copy && <button className="button secondary" disabled={busy || !canQueueCopy} onClick={() => void copyText(copy)}><Clipboard size={15} />复制</button>}
          </div>
          {availableTabs.length > 0 && <div className="cf-result-tabs" role="tablist" aria-label="生成结果渠道">
            {availableTabs.map(channel => <button key={channel} id={`${channelIds}-tab-${channel}`} role="tab" type="button"
              aria-selected={active === channel} tabIndex={active === channel ? 0 : -1}
              onKeyDown={event => selectResultFromKeyboard(event, channel)}
              onClick={() => setResultTab(channel)}>{FACTORY_CHANNELS[channel]}</button>)}
          </div>}
          <div className="cf-channel-panel" role={active ? 'tabpanel' : undefined}
            aria-labelledby={active ? `${channelIds}-tab-${active}` : undefined}
            tabIndex={active && !copy && !showPosters && (!canGenerateActive || busy) ? 0 : undefined}>
          {copy ? <div className="cf-copy">
            <div className="cf-preview"><strong>{FACTORY_CHANNELS[copy.channel]}</strong><span>{Array.from(copy.body.trim()).length} 字</span></div>
            <label className="cf-field">{copy.channel === 'email' ? '邮件主题行' : '标题'}<input value={copy.title} maxLength={160} disabled={busy} onChange={event => updateCopy(copy.channel, 'title', event.target.value)} /></label>
            {(copy.channel === 'email' || copy.channel === 'xiaohongshu' || copy.alternateTitle) && <label className="cf-field">备选标题<input value={copy.alternateTitle} maxLength={160} disabled={busy} onChange={event => updateCopy(copy.channel, 'alternateTitle', event.target.value)} /></label>}
            <label className="cf-field">正文<textarea value={copy.body} maxLength={copy.channel === 'sms' ? 70 : 6000} rows={copy.channel === 'sms' ? 3 : 9} disabled={busy} onChange={event => updateCopy(copy.channel, 'body', event.target.value)} /></label>
            <div className="cf-actions">
              <button className="button secondary" disabled={busy || ready === false || !brief.channels.includes(copy.channel)} onClick={() => void generate(copy.channel)}><RefreshCw size={15} />换一版</button>
              <button className="button primary" disabled={busy || !canQueueCopy} onClick={() => addToQueue({ channel: copy.channel, assetId: copy.channel, title: copy.title, body: copy.body })}><ListPlus size={15} />加入发布队列</button>
            </div>
          </div> : active === 'poster' && generated?.posters.length ? <div className="cf-copy">
            <div className="cf-preview"><strong>视觉物料</strong><div className="cf-actions">
              <button className="button secondary" disabled={busy || ready === false || !brief.channels.includes('poster')} onClick={() => void generate('poster')}><RefreshCw size={15} />重新生成</button>
              <button className="button secondary" disabled={busy} onClick={() => void exportAll(generated.posters)}><Download size={15} />导出全部</button>
            </div></div>
            <div className="cf-poster-grid">{generated.posters.map(board => <article className="cf-poster" key={board.id}>
              <button type="button" aria-label={`预览${board.name}`} className="cf-poster-preview" disabled={busy} onClick={() => setPreview(board)}><PosterArt board={board} /></button>
              <h4>{board.name}</h4><p>{board.width} × {board.height}</p>
              <div className="cf-actions"><button className="button ghost" disabled={busy} onClick={() => void exportPoster(board)}><Download size={14} />下载</button>
                <button className="button secondary" disabled={busy} onClick={() => addToQueue({ channel: 'poster', assetId: board.id, title: board.name, body: '', poster: board })}>加入队列</button></div>
            </article>)}</div>
          </div> : <div className="cf-empty">
            <CreativeCanvasIllustration className="cf-empty-art" />
            <h4>{active && (generated || error) ? `还没有${FACTORY_CHANNELS[active]}` : '从一次活动开始'}</h4>
            {canGenerateActive && active
              ? <button type="button" className="button secondary" disabled={busy} onClick={() => void generate(active)}><RefreshCw size={15} />生成当前渠道</button>
              : <>
                <p>填写左侧活动主题与受众定位，一键生成多渠道文案草稿、视觉物料与排期建议。</p>
                <div className="cf-empty-Badges" aria-hidden="true"><span>公众号深度长文</span><span>小红书种草笔记</span><span>海报画板预览</span><span>受众触达建议</span></div>
              </>}
          </div>}
          </div>
        </section>
        {generated?.audience && <section className="cf-insight cf-panel" aria-label="AI 人群洞察">
          <div className="cf-panel-head"><div><h3><Users size={16} />AI 人群洞察</h3><p>基于本次填写的活动需求</p></div></div>
          <div className="cf-copy"><div><h4>核心受众</h4><p>{generated.audience.summary}</p></div>
            {generated.audience.tags.length > 0 && <div className="cf-chips">{generated.audience.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
            <div><h4>建议触达节奏</h4><p>{generated.audience.nextStep}</p></div>
          </div>
        </section>}
      </div>
    </div>

    {historyOpen && <Overlay title="历史素材" className="cf-queue cf-history-dialog" onClose={() => { if (!historyBusy) setHistoryOpen(false); }}>
      {History ? <History onBusyChange={setHistoryBusy} /> : <div className="cf-copy">
        {historyError ? <><p role="alert">{historyError}</p><button className="button secondary" onClick={() => void openHistory()}>重新加载</button></> :
          <p role="status">正在加载历史素材…</p>}
      </div>}
    </Overlay>}

    {queueOpen && <Overlay title="发布队列" className="cf-queue" onClose={() => { if (!busy) setQueueOpen(false); }}>
      <div className="cf-copy">
        <p>在这里登记审核和计划时间。审核与发布由团队人工完成。</p>
        {error && <p className="cf-feedback" role="alert">{error}</p>}
        {queue.length ? <ul className="cf-queue-list">{queue.map(item => <li className="cf-queue-item" key={item.id}>
          <div><strong>{item.title}</strong><p>{FACTORY_CHANNELS[item.channel]} · {statusText[item.status]}{item.scheduledAt ? ` · ${dateLabel(item.scheduledAt)}` : ''}</p></div>
          <div className="cf-actions">
            {(item.status === 'review' || item.status === 'scheduled') && <button className="button secondary" disabled={busy}
              onClick={() => void save({ ...document, queue: queue.map(entry => entry.id === item.id ? { ...entry, status: 'approved' } : entry) })}><BadgeCheck size={15} />标为已审核</button>}
            <button className="button secondary" disabled={busy} onClick={() => openReview(item.id)}><CalendarDays size={14} />{item.scheduledAt ? '调整排期' : '登记排期'}</button>
            <button className="icon-button" aria-label={`移除${item.title}`} disabled={busy} onClick={() => setDocument(value => ({ ...value, queue: value.queue.filter(entry => entry.id !== item.id) }))}><Trash2 size={16} /></button>
          </div>
        </li>)}</ul> : <div className="cf-empty"><ListPlus size={22} /><p>从生成结果加入文案或海报。</p></div>}
        {queue.length > 0 && <div className="cf-actions"><button className="button secondary" disabled={busy || !changed} onClick={() => void save()}>保存队列</button>
          <button className="button primary" disabled={busy || !hasDrafts} onClick={() => openReview()}><CalendarDays size={15} />送审并排期</button></div>}
      </div>
    </Overlay>}

    {reviewOpen && <Overlay title="送审并排期" className="cf-queue" onClose={() => { if (!busy) setReviewOpen(false); }}>
      <form className="cf-copy" onSubmit={event => void submitReview(event)}>
        <p>将 {reviewTarget ? 1 : queue.filter(item => item.status === 'draft').length} 条内容登记为待审核。计划时间可稍后补充。</p>
        <label className="cf-field">计划发布时间<input type="datetime-local" value={scheduleDate} disabled={busy}
          data-dialog-initial-focus aria-invalid={scheduleError ? true : undefined}
          aria-describedby={scheduleError ? reviewNoteId : undefined}
          onChange={event => { setScheduleDate(event.target.value); setScheduleError(''); }} /></label>
        {scheduleError && <p id={reviewNoteId} className="cf-feedback" role="alert">{scheduleError}</p>}
        {error && <p className="cf-feedback" role="alert">{error}</p>}
        <div className="cf-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => setReviewOpen(false)}>取消</button>
          <button className="button primary" type="submit" disabled={busy}><BadgeCheck size={15} />确认送审</button></div>
      </form>
    </Overlay>}

    {replaceTarget !== null && <Overlay title="切换活动" className="cf-queue" onClose={() => setReplaceTarget(null)}>
      <div className="cf-copy"><p>当前草稿有改动。保存后再切换，或放弃这次改动。</p>
        {error && <p className="cf-feedback" role="alert">{error}</p>}
        <div className="cf-actions">
          <button className="button secondary" disabled={busy} data-dialog-initial-focus onClick={() => setReplaceTarget(null)}>继续编辑</button>
          <button className="button secondary" disabled={busy} onClick={() => selectCampaign(replaceTarget)}>放弃并切换</button>
          <button className="button primary" disabled={busy} onClick={async () => { if (await save()) selectCampaign(replaceTarget); }}><Check size={15} />保存并切换</button>
        </div></div>
    </Overlay>}

    {preview && <Overlay title={preview.name} className="cf-queue cf-poster-dialog" onClose={() => { if (!busy) setPreview(null); }}>
      <div className="cf-copy"><PosterArt board={preview} />
        {error && <p className="cf-feedback" role="alert">{error}</p>}
        <button className="button secondary" disabled={busy} onClick={() => void exportPoster(preview)}><Download size={15} />下载 PNG</button></div>
    </Overlay>}
  </div>;
}

function PosterArt({ board }: { board: StudioBoard }) {
  return <div className="cf-poster-art" aria-hidden="true" style={{ aspectRatio: `${board.width} / ${board.height}`, background: studioColor(board.background, '#ffffff') }}>
    {board.layers.map(layer => <span key={layer.id} data-kind={layer.kind} style={{
      ...studioLayerStyle(layer), fontSize: `${layer.fontSize / board.width * 100}cqw`, borderRadius: `${layer.radius / board.width * 100}cqw`,
    }}>{layer.text}</span>)}
  </div>;
}
