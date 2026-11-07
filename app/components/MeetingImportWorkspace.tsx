'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, AudioLines, Building2, Check, ChevronDown, CircleAlert, FileText, Loader2, Monitor, RefreshCw, Search, Users, Video } from 'lucide-react';
import type { WorkbenchState } from '../lib/types';
import type { MeetingAnalysis, MeetingEntity, MeetingImport, MeetingJobView, MeetingRecord, MeetingSearchInput, MeetingSyncView } from '../lib/meeting-import-types';
import { AnswerContent } from './AnswerContent';
import './meeting-import.css';

const emptySync: MeetingSyncView = { device: { online: false, authorized: false }, jobs: [], imports: [] };

async function responseBody<T>(response: Response): Promise<T> {
  let body: T & { error?: string; message?: string };
  try { body = await response.json() as T & { error?: string; message?: string }; }
  catch { throw new Error('会议服务暂时没有响应，请稍后刷新。'); }
  if (!response.ok) throw new Error(body.error || body.message || '这次操作没有完成，请稍后重试。');
  return body;
}

function displayDate(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '时间待确认';
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function recordStatus(record: MeetingRecord): string {
  const status = record.state.toLowerCase();
  if (/transcod|processing|转码/.test(status)) return '正在转码';
  if (/recording|录制中/.test(status)) return '正在录制';
  if (status === 'unavailable') return '暂不可导入';
  if (/^(ready|completed|finished)$|^可用$|^已完成$/.test(status)) return '可导入';
  return /^\d+$/.test(status) ? '以读取结果为准' : record.state || '以读取结果为准';
}

function unavailable(record: MeetingRecord): boolean {
  return !record.recordFileId || /recording|transcod|processing|unavailable|not[_ -]?ready|录制中|转码|未就绪/.test(record.state.toLowerCase());
}

function EntityList({ title, entities, kind }: { title: string; entities: MeetingEntity[]; kind: 'company' | 'person' }) {
  const Icon = kind === 'company' ? Building2 : Users;
  return <section className="meeting-entities"><h3><Icon size={16} />{title}<span>{entities.length}</span></h3>
    {entities.length ? entities.map((entity, index) => <article className="meeting-entity" key={`${entity.name}-${index}`}>
      <h4>{entity.name}</h4>
      {entity.facts.length > 0 && <dl>{entity.facts.map((fact, factIndex) => <div key={`${fact.field}-${factIndex}`}><dt>{fact.field}</dt><dd>{fact.value}<details className="meeting-evidence"><summary>查看依据<ChevronDown size={12} /></summary><p className="meeting-evidence-quote">{fact.quote}</p><small>{fact.source === 'transcript' ? '来源：会议转写' : '来源：会议纪要'}</small></details></dd></div>)}</dl>}
      <details className="meeting-evidence"><summary>会议中的提及<ChevronDown size={12} /></summary><p className="meeting-evidence-quote">{entity.quote}</p><small>{entity.source === 'transcript' ? '来源：会议转写' : '来源：会议纪要'}</small></details>
    </article>) : <p className="meeting-quiet">这份材料中没有提取到证据充分的{kind === 'company' ? '企业' : '人物'}信息。</p>}
  </section>;
}

export function MeetingAnalysisContent({ analysis, busy = false, onReanalyze }: { analysis: MeetingAnalysis; busy?: boolean; onReanalyze?: () => void }) {
  return <div className="meeting-analysis">
    {analysis.status !== 'ready' && <div className="meeting-message" role="status">{analysis.status === 'pending' ? <Loader2 size={16} className="spin" /> : <CircleAlert size={16} />}<div><strong>{analysis.status === 'pending' ? '正在整理会议画像' : analysis.status === 'needs_model' ? '原文已保存，画像待生成' : '原文已保存，画像暂未生成'}</strong><p>{analysis.message || (analysis.status === 'pending' ? '完成后会显示有来源依据的企业和人物信息。' : '请确认模型服务可用，再重新生成。')}</p>{onReanalyze && analysis.status !== 'pending' && <button className="button secondary" disabled={busy} onClick={onReanalyze}>{busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}重新生成画像</button>}</div></div>}
    {analysis.summary && <div className="meeting-analysis-summary"><h3>沟通要点</h3><AnswerContent text={analysis.summary} /></div>}
    {(analysis.status === 'ready' || analysis.companies.length > 0 || analysis.people.length > 0) && <><p className="meeting-profile-caption">来源：会议材料 · 人物身份及企业关系待业务确认</p><EntityList title="会议提及的企业" entities={analysis.companies} kind="company" /><EntityList title="会议提及的人物" entities={analysis.people} kind="person" /></>}
    {analysis.nextSteps.length > 0 && <section className="meeting-next-steps"><h3>建议下一步</h3><ul>{analysis.nextSteps.map((step, index) => <li key={index}><ArrowRight size={14} /><span>{step}</span></li>)}</ul></section>}
  </div>;
}

function ImportDetail({ item, onReanalyze, busy }: { item: MeetingImport; onReanalyze: () => void; busy: boolean }) {
  return <div className="meeting-import-detail">
    {!item.complete && <div className="meeting-message"><CircleAlert size={16} /><p>当前导入内容不完整，请结合下方提示核对覆盖范围。</p></div>}
    {item.warnings.length > 0 && <ul className="meeting-import-warnings">{item.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {item.media ? <section className="meeting-audio"><h3><AudioLines size={16} />会议录音</h3><audio controls preload="none" src={`/api/meeting-imports/media/${encodeURIComponent(item.media.id)}`} aria-label={`${item.record.subject}的录音`} /><small>{item.media.name} · {(item.media.size / 1024 / 1024).toFixed(1)} MB</small></section> : <p className="meeting-quiet">本次未保存录音文件，纪要和转写的获取结果见下方。</p>}
    <MeetingAnalysisContent analysis={item.analysis} onReanalyze={onReanalyze} busy={busy} />
    <details className="meeting-document"><summary><FileText size={16} /><span>会议纪要</span><small>{item.minutes ? `${item.minutes.length.toLocaleString('zh-CN')} 字` : '未获取'}</small><ChevronDown size={15} /></summary>{item.minutes ? <AnswerContent text={item.minutes} /> : <p className="meeting-quiet">没有获取到可读取的纪要。请确认会议已生成纪要，并且当前腾讯会议账号有访问权限。</p>}</details>
    <details className="meeting-document"><summary><AudioLines size={16} /><span>会议转写</span><small>{item.transcript ? `${item.transcript.length.toLocaleString('zh-CN')} 字` : '未获取'}</small><ChevronDown size={15} /></summary>{item.transcript ? <div className="meeting-original-text">{item.transcript}</div> : <p className="meeting-quiet">没有获取到转写原文。会议纪要会单独保留，不会作为逐字稿使用。</p>}</details>
  </div>;
}

export function MeetingImportWorkspace({ state, onWorkspaceRefresh, initialDealId, admin = false, compact = false, onOpenProjects }: {
  state: WorkbenchState;
  onWorkspaceRefresh: () => Promise<void>;
  initialDealId?: string | null;
  admin?: boolean;
  compact?: boolean;
  onOpenProjects?: () => void;
}) {
  const prefix = useId();
  const [sync, setSync] = useState<MeetingSyncView>(emptySync);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState<'search' | 'import' | 'analysis' | null>(null);
  const [query, setQuery] = useState('');
  const [dealId, setDealId] = useState(initialDealId && state.deals.some(deal => deal.id === initialDealId) ? initialDealId : '');
  const [recordKey, setRecordKey] = useState('');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeetingImport | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [localSearch, setLocalSearch] = useState<{ jobId: string; input: MeetingSearchInput; page: number | null } | null>(null);
  const mounted = useRef(true);
  const controllers = useRef(new Set<AbortController>());
  const watchedJobs = useRef(new Set<string>());
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const requestPending = useRef(false);
  const expandedRef = useRef<string | null>(null);
  const selectedDealExists = state.deals.some(deal => deal.id === dealId);
  const latestSearch = [...sync.jobs].filter(job => job.kind === 'search').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const searchMetadata = latestSearch;
  const currentSearchContext = searchMetadata?.search || (latestSearch?.id === localSearch?.jobId ? localSearch?.input : undefined);
  const currentPage = latestSearch?.id === localSearch?.jobId ? localSearch?.page : null;
  const records = latestSearch?.records || [];
  const selectedRecord = records.find(record => record.key === recordKey);
  const activeJobs = sync.jobs.filter(job => job.status === 'queued' || job.status === 'running');
  const importRunning = activeJobs.some(job => job.kind === 'import');
  const searchRunning = activeJobs.some(job => job.kind === 'search');
  const canRead = sync.device.online && sync.device.authorized;

  const request = useCallback(async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try { return await responseBody<T>(await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal })); }
    finally { controllers.current.delete(controller); }
  }, []);

  const loadSync = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await request<MeetingSyncView>('/api/meeting-imports');
      if (!mounted.current || current !== generation.current) return;
      setSync(next); setConnectionError('');
    } catch (reason) {
      if (mounted.current && current === generation.current && !(reason instanceof DOMException && reason.name === 'AbortError')) setConnectionError(reason instanceof Error ? reason.message : '同步状态未能加载，请刷新。');
    } finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [request]);

  const loadDetail = useCallback(async (id: string) => {
    const current = ++detailGeneration.current;
    setDetailLoading(true); setDetail(null);
    try {
      const next = await request<{ import: MeetingImport }>(`/api/meeting-imports?importId=${encodeURIComponent(id)}`);
      if (mounted.current && current === detailGeneration.current) setDetail(next.import);
    } catch (reason) {
      if (mounted.current && current === detailGeneration.current && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : '会议详情未能加载，请重试。');
    } finally { if (mounted.current && current === detailGeneration.current) setDetailLoading(false); }
  }, [request]);

  useEffect(() => {
    mounted.current = true;
    const currentControllers = controllers.current;
    void Promise.resolve().then(() => { if (mounted.current) return loadSync(); });
    const timer = setInterval(() => { void loadSync(); }, 5000);
    return () => { mounted.current = false; clearInterval(timer); for (const controller of currentControllers) controller.abort(); currentControllers.clear(); };
  }, [loadSync]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      if (!mounted.current) return;
      for (const job of sync.jobs) {
        if (!watchedJobs.current.has(job.id) || (job.status !== 'done' && job.status !== 'failed')) continue;
        watchedJobs.current.delete(job.id);
        if (job.status === 'failed') { setError(job.error || '会议任务未完成，可检查连接后重新发起。'); continue; }
        if (job.kind === 'import') {
          setNotice('会议内容已保存到项目，正在同步客户洞察。');
          void onWorkspaceRefresh().catch(() => { if (mounted.current) setNotice('会议内容已保存。项目页面暂未刷新，请稍后重新打开。'); });
          if (job.importId && !expandedRef.current) { expandedRef.current = job.importId; setExpandedId(job.importId); void loadDetail(job.importId); }
        }
      }
    });
  }, [sync.jobs, onWorkspaceRefresh, loadDetail]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      if (!mounted.current) return;
      setDetail(previous => {
        if (!previous) return previous;
        const summary = sync.imports.find(item => item.id === previous.id);
        if (!summary || summary.sourceHash !== previous.sourceHash || JSON.stringify(summary.analysis) === JSON.stringify(previous.analysis)) return previous;
        return { ...previous, analysis: summary.analysis, complete: summary.complete, warnings: summary.warnings, media: summary.media };
      });
    });
  }, [sync.imports]);

  const postJob = async (action: 'search' | 'import', input: Record<string, unknown>) => {
    if (requestPending.current) return;
    requestPending.current = true; setBusy(action); setError(''); setNotice('');
    try {
      const next = await request<{ job: MeetingJobView }>('/api/meeting-imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...input }) });
      if (!mounted.current) return;
      watchedJobs.current.add(next.job.id);
      setSync(previous => ({ ...previous, jobs: [next.job, ...previous.jobs.filter(job => job.id !== next.job.id)] }));
      if (action === 'search') {
        setLocalSearch({ jobId: next.job.id, input: { ...(typeof input.query === 'string' ? { query: input.query } : {}), ...(typeof input.meetingCode === 'string' ? { meetingCode: input.meetingCode } : {}) }, page: typeof input.pageToken !== 'string' ? 1 : currentPage ? currentPage + 1 : null });
        setRecordKey('');
      }
      void loadSync();
    } catch (reason) { if (mounted.current && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : '会议任务未能提交，请重试。'); }
    finally { requestPending.current = false; if (mounted.current) setBusy(null); }
  };

  const searchMeetings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = query.trim(); const digits = text.replace(/[\s-]/g, '');
    void postJob('search', /^\d{6,12}$/.test(digits) ? { meetingCode: digits } : text ? { query: text } : {});
  };

  const reanalyze = async () => {
    if (!detail || requestPending.current) return;
    requestPending.current = true; setBusy('analysis'); setError('');
    try {
      const result = await request<{ import: MeetingImport }>('/api/meeting-imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reanalyze', importId: detail.id }) });
      if (mounted.current) { setDetail(result.import); void loadSync(); }
    } catch (reason) { if (mounted.current && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : '画像暂未生成，请稍后重试。'); }
    finally { requestPending.current = false; if (mounted.current) setBusy(null); }
  };

  const deviceTitle = !sync.device.id ? '本机同步助手未连接' : !sync.device.online ? '本机同步助手离线' : !sync.device.authorized ? '腾讯会议账号待授权' : '腾讯会议已连接';
  const deviceMessage = !sync.device.id ? '请联系管理员连接本机同步助手，完成后刷新状态。' : !sync.device.online ? '请保持已连接的电脑开机，并启动同步助手。' : !sync.device.authorized ? '请在已连接的电脑完成腾讯会议账号授权，再刷新状态。' : `${sync.device.label || '本机同步助手'} · 仅可读取当前账号授权的录制。`;

  return <div className={`meeting-workspace${compact ? ' is-compact' : ''}${admin ? ' is-admin' : ''}`}>
    <header className="meeting-page-heading"><div><h1>{admin ? '腾讯会议接入' : '会议导入'}</h1></div></header>
    <section className={`meeting-connection${canRead ? ' is-connected' : ''}`} aria-label="腾讯会议连接状态">
      <Monitor size={18} /><div><strong>{loading ? '正在读取连接状态…' : deviceTitle}</strong><p>{loading ? '请稍候。' : deviceMessage}</p>{sync.device.lastSeenAt && <small>最近在线 {displayDate(sync.device.lastSeenAt)}</small>}</div><button className="icon-button" onClick={() => { void loadSync(); }} aria-label="刷新腾讯会议连接状态"><RefreshCw size={16} /></button>
    </section>
    {(error || connectionError) && <div className="meeting-message is-error" role="alert"><CircleAlert size={16} /><p>{error || connectionError}</p></div>}
    {admin ? <p className="meeting-admin-note">内容按项目权限访问；账号授权保留在连接电脑。</p> : <>
      <section className="meeting-project-choice"><label htmlFor={`${prefix}-project`}>目标项目</label><select id={`${prefix}-project`} value={selectedDealExists ? dealId : ''} disabled={busy !== null} onChange={event => setDealId(event.target.value)}><option value="">选择项目</option>{state.deals.map(deal => <option key={deal.id} value={deal.id}>{deal.projectName || deal.name}{deal.projectName && deal.projectName !== deal.name ? ` · ${deal.name}` : ''}</option>)}</select>{!state.deals.length && <div className="meeting-inline-help"><p>先录入一个客户项目，再导入相关会议。</p>{onOpenProjects && <button className="text-button" onClick={onOpenProjects}>前往项目中心 <ArrowRight size={13} /></button>}</div>}</section>
      <section className="meeting-source-section"><div className="meeting-section-heading"><h2>选择会议</h2><span>最近 30 天</span></div><form className="meeting-search" onSubmit={searchMeetings} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}><label className="meeting-search-input" htmlFor={`${prefix}-search`}><Search size={16} /><span className="sr-only">会议号或关键词</span><input id={`${prefix}-search`} value={query} maxLength={50} onChange={event => setQuery(event.target.value)} placeholder="会议号或关键词" disabled={busy !== null || searchRunning} /></label><button className="button secondary" disabled={!canRead || busy !== null || searchRunning}>{busy === 'search' || searchRunning ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}{searchRunning ? '正在查找' : query.trim() ? '查找会议' : '读取最近会议'}</button></form>
        {searchRunning ? <div className="meeting-job-progress" role="status"><Loader2 size={17} className="spin" /><div><strong>正在读取会议列表</strong></div></div> : records.length ? <fieldset className="meeting-record-options"><legend className="sr-only">选择要导入的会议录制</legend>{records.map(record => { const Icon = record.kind === 'audio' ? AudioLines : Video; return <label className={`meeting-record-option${recordKey === record.key ? ' is-selected' : ''}`} key={record.key}><input type="radio" name={`${prefix}-record`} value={record.key} checked={recordKey === record.key} disabled={busy !== null || importRunning || unavailable(record)} onChange={() => setRecordKey(record.key)} /><span className="meeting-record-content"><strong>{record.subject || '未命名会议'}</strong><span><Icon size={13} />{record.kind === 'audio' ? '录音' : record.kind === 'video' ? '录制' : '会议文件'}<span>·</span>{displayDate(record.startedAt)}</span>{record.meetingCode && <small>会议号 {record.meetingCode}</small>}<small>{recordStatus(record)}</small></span><span className="meeting-radio-mark" aria-hidden="true">{recordKey === record.key && <Check size={12} />}</span></label>; })}</fieldset> : <div className="meeting-empty"><FileText size={24} /><p>{latestSearch?.status === 'failed' ? '这次会议查询未完成' : latestSearch?.status === 'done' ? '这个范围内没有找到可访问的录制' : '先读取会议列表'}</p><span>{latestSearch?.status === 'failed' ? latestSearch.error || '检查连接状态后可重新查找。' : latestSearch?.status === 'done' ? '可以换个关键词或会议号；会议需已录制，并有相应访问权限。' : '录制、纪要和转写按腾讯会议账号的实际权限获取。'}</span></div>}
        {records.length > 0 && <p className="meeting-page-count">{currentPage ? `第 ${currentPage} 页 · ` : '本次返回 '}{records.length} 个录制文件</p>}
        {latestSearch?.hasMore && <div className="meeting-load-more">{searchMetadata?.pageToken && currentSearchContext ? <button className="button secondary" disabled={!canRead || busy !== null || searchRunning || importRunning} onClick={() => { void postJob('search', { ...currentSearchContext, pageToken: searchMetadata.pageToken }); }}>加载更多会议 <ArrowRight size={14} /></button> : <p>输入关键词或会议号重新查找，可以缩小范围。</p>}</div>}
        <div className="meeting-import-action"><label className="meeting-audio-toggle"><input type="checkbox" checked={includeAudio} disabled={busy !== null || importRunning} onChange={event => setIncludeAudio(event.target.checked)} /><span>同时保存可下载的录音</span></label><button className="button primary" disabled={!canRead || !selectedDealExists || !selectedRecord || unavailable(selectedRecord) || busy !== null || importRunning || !latestSearch || latestSearch.status !== 'done'} onClick={() => { if (latestSearch && selectedRecord) void postJob('import', { dealId, searchJobId: latestSearch.id, recordKey: selectedRecord.key, includeAudio }); }}>{busy === 'import' || importRunning ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />}{importRunning ? '正在导入会议内容' : '导入并生成画像'}</button>{!selectedDealExists && state.deals.length > 0 && <p>请先选择目标项目，再导入会议。</p>}</div>
      </section>
      {importRunning && <div className="meeting-job-progress" role="status"><Loader2 size={18} className="spin" /><div><strong>正在保存会议材料</strong><p>纪要、转写与录音分别读取，可稍后查看结果。</p></div></div>}
      {notice && <div className="meeting-message is-success" role="status"><Check size={16} /><p>{notice}</p></div>}
      <section className="meeting-import-history"><div className="meeting-section-heading"><h2>已导入会议</h2><span>{sync.imports.length} 场</span></div>{loading ? <div className="meeting-loading" aria-label="正在加载已导入会议"><span /><span /><span /></div> : sync.imports.length ? <div className="meeting-import-items">{sync.imports.map(item => <article className="meeting-saved-import" key={item.id}><button className="meeting-saved-heading" aria-expanded={expandedId === item.id} aria-controls={`${prefix}-${item.id}`} onClick={() => { const id = expandedId === item.id ? null : item.id; expandedRef.current = id; setExpandedId(id); if (id) void loadDetail(id); else { detailGeneration.current++; setDetail(null); setDetailLoading(false); } }}><span><strong>{item.record.subject}</strong><small>{state.deals.find(deal => deal.id === item.dealId)?.projectName || state.deals.find(deal => deal.id === item.dealId)?.name || '关联项目'} · {displayDate(item.createdAt)}</small><span className="meeting-saved-flags"><span>{item.analysis.status === 'ready' ? '画像已生成' : item.analysis.status === 'pending' ? '画像生成中' : '画像待生成'}</span>{item.media && <span>含录音</span>}{!item.complete && <span>内容需核对</span>}</span></span><ChevronDown size={17} /></button>{expandedId === item.id && <div id={`${prefix}-${item.id}`} className="meeting-saved-body">{detailLoading ? <p className="meeting-detail-loading"><Loader2 size={16} className="spin" />正在读取会议内容…</p> : detail?.id === item.id ? <ImportDetail item={detail} onReanalyze={() => { void reanalyze(); }} busy={busy === 'analysis'} /> : <button className="button secondary" onClick={() => { void loadDetail(item.id); }}>重新加载会议内容</button>}</div>}</article>)}</div> : <p className="meeting-history-empty">暂无已导入会议</p>}</section>
    </>}
  </div>;
}
