'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ExternalLink, History, RefreshCw, Search } from 'lucide-react';
import type { WebPlatform, WebProspectLead, WebProspectSnapshot, WebProspectTask } from '../lib/web-prospect-types.ts';
import { ProspectingFilters, ProspectingList, ProspectingPanel } from './ProspectingInbox';
import './WebProspecting.css';

const platforms: { id: WebPlatform; label: string }[] = [
  { id: 'all', label: '全网公开索引' }, { id: 'tieba', label: '百度贴吧' },
  { id: 'xiaohongshu', label: '小红书' }, { id: 'zhihu', label: '知乎' },
  { id: 'weibo', label: '微博' }, { id: 'other', label: '其他网站' },
];
const taskLabels = { running: '搜索中', completed: '已完成', partial: '部分来源失败', failed: '搜索失败' };
const reviewLabels = { new: '待审核', qualified: '有效线索', ignored: '已忽略' };
type Filter = 'all' | WebProspectLead['status'];
type Panel = { kind: 'search' } | { kind: 'lead'; id: string };
type ConversionDraft = { company: string; project: string; salesId: string };
const emptyDraft: ConversionDraft = { company: '', project: '', salesId: '' };

function publicSource(value: string) {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url;
  } catch { /* The link is optional when the index has no valid source URL. */ }
}

function sourceLabel(lead: WebProspectLead) {
  return publicSource(lead.sourceUrl)?.hostname || platforms.find(item => item.id === lead.platform)?.label || '公开网页';
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString('zh-CN');
}

function LeadStatus({ lead }: { lead: WebProspectLead }) {
  return <span className="web-prospect-chip" data-state={lead.projectId ? 'converted' : lead.status}>
    {lead.projectId ? '已建项目' : reviewLabels[lead.status]}
  </span>;
}

function SearchHistory({ tasks }: { tasks: WebProspectTask[] }) {
  if (!tasks.length) return null;
  return <details className="web-prospect-disclosure">
    <summary><History size={16} aria-hidden="true" />搜索记录<ChevronDown size={14} aria-hidden="true" /></summary>
    <ol className="web-prospect-history-list" aria-label="搜索记录">
      {tasks.map(task => <li key={task.id}>
        <div><strong>{task.keywords.join('、')}</strong><span className="web-prospect-chip" data-state={task.status}>{taskLabels[task.status]}</span></div>
        <p>{task.region || '未指定地区'} · {task.resultCount} 个来源 · {dateLabel(task.createdAt)}</p>
      </li>)}
    </ol>
  </details>;
}

function TaskStatus({ task }: { task: WebProspectTask }) {
  return <div className="web-prospect-status" role="status">
    <div className="web-prospect-task-line">
      <strong className="web-prospect-chip" data-state={task.status}>{taskLabels[task.status]}</strong>
      <span>{task.keywords.join('、')}{task.region && ` · ${task.region}`}</span>
      <span className="web-prospect-task-total">{task.resultCount} 个来源 · {dateLabel(task.createdAt)}</span>
    </div>
    {task.errors.length > 0 && <ul>{task.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>}
    {task.status === 'completed' && task.resultCount === 0 &&
      <p>本次搜索成功，但未找到匹配的公开来源。可调整关键词或地区。</p>}
  </div>;
}

interface Props {
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onNavigateProject?: (id: string) => void;
  toolbarStart?: ReactNode;
  toolbarActions?: ReactNode;
}

async function readSnapshot(body?: Record<string, unknown>, fallback = '操作失败，请重试') {
  const response = await fetch('/api/web-prospects', body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const data = await response.json() as WebProspectSnapshot & { error?: string };
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

export default function WebProspecting({ onDirtyChange, onBusyChange, onNavigateProject, toolbarStart, toolbarActions }: Props) {
  const [snapshot, setSnapshot] = useState<WebProspectSnapshot>({ tasks: [], leads: [] });
  const [keywords, setKeywords] = useState('');
  const [region, setRegion] = useState('');
  const [platform, setPlatform] = useState<WebPlatform>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [listQuery, setListQuery] = useState('');
  const [panel, setPanel] = useState<Panel | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchDirty, setSearchDirty] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ConversionDraft>>({});
  const identity = useRef<{ payload: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const term = listQuery.trim().toLowerCase();
  const items = snapshot.leads.filter(item => (filter === 'all' || item.status === filter) &&
    (!term || [item.title, item.excerpt, sourceLabel(item), item.sourceUrl].some(text => text.toLowerCase().includes(term))));
  const lead = panel?.kind === 'lead' ? snapshot.leads.find(item => item.id === panel.id) : undefined;
  const draft = lead ? drafts[lead.id] ?? emptyDraft : emptyDraft;
  const latest = snapshot.tasks[0];
  const needsOwner = Boolean(snapshot.owners?.length);
  const dirty = searchDirty || Object.values(drafts).some(item => Boolean(item.company.trim() || item.project.trim() || item.salesId));

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    let active = true;
    void readSnapshot(undefined, '读取失败').then(data => {
      if (active) setSnapshot(data);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '读取失败');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  function closePanel() {
    setPanel(null);
    requestAnimationFrame(() => {
      const focus = opener.current && document.contains(opener.current) ? opener.current : searchButton.current;
      focus?.focus({ preventScroll: true });
    });
  }

  function updateDraft(change: Partial<ConversionDraft>) {
    if (!lead) return;
    setDrafts(previous => ({ ...previous, [lead.id]: { ...(previous[lead.id] ?? emptyDraft), ...change } }));
  }

  async function execute(body?: Record<string, unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await readSnapshot(body);
      setSnapshot(data);
      setDrafts(previous => {
        const converted = new Set(data.leads.filter(item => item.projectId).map(item => item.id));
        const current = Object.keys(previous);
        return current.some(id => converted.has(id))
          ? Object.fromEntries(current.filter(id => !converted.has(id)).map(id => [id, previous[id]]))
          : previous;
      });
      if (body?.action === 'search') {
        identity.current = null;
        setSearchDirty(false);
        if (!data.tasks[0] || data.tasks[0].status === 'completed') closePanel();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请求失败，请重试');
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  function search() {
    const input = { keywords: keywords.split(/[\n，,]/).map(value => value.trim()).filter(Boolean), region, platform };
    const payload = JSON.stringify(input);
    if (identity.current?.payload !== payload) identity.current = { payload, id: crypto.randomUUID() };
    void execute({ action: 'search', ...input, requestId: identity.current.id });
  }

  function openPanel(next: Panel) {
    if (inFlight.current) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(next);
  }

  function review(next: WebProspectLead['status']) {
    if (!lead) return;
    void execute({ action: 'review', leadId: lead.id, version: lead.version, status: next });
  }

  const source = lead ? publicSource(lead.sourceUrl) : undefined;
  const showPanel = panel?.kind === 'search' || Boolean(lead);
  const errorMessage = error && <div className="web-prospect-error" role="alert">
    <span>{error}</span>
    <button type="button" onClick={() => void execute()} disabled={busy}>重新读取</button>
  </div>;

  return <section className="web-prospect" aria-label="公开网页线索">
    <ProspectingFilters className="web-prospect-toolbar">
      {toolbarStart}
      <label className="search-field web-prospect-list-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" aria-label="查找公开线索" value={listQuery} placeholder="查找线索" disabled={busy}
          onChange={event => setListQuery(event.target.value)} />
      </label>
      <select aria-label="审核筛选" value={filter} disabled={busy} onChange={event => setFilter(event.target.value as Filter)}>
        <option value="all">全部状态</option>
        <option value="new">待审核</option>
        <option value="qualified">有效线索</option>
        <option value="ignored">已忽略</option>
      </select>
      <button type="button" className="web-prospect-icon-button" onClick={() => void execute()} disabled={busy || loading}
        aria-label="刷新线索" title="刷新线索"><RefreshCw size={16} aria-hidden="true" /></button>
      {toolbarActions}
      <button type="button" ref={searchButton} className="web-prospect-primary web-prospect-search-trigger" disabled={busy || loading}
        aria-expanded={panel?.kind === 'search'} onClick={() => openPanel({ kind: 'search' })}>
        <Search size={15} aria-hidden="true" />搜索公开网页
      </button>
    </ProspectingFilters>

    {!showPanel && errorMessage}
    {latest && latest.status !== 'completed' && panel?.kind !== 'search' && <TaskStatus task={latest} />}
    <div className="prospect-inbox-split web-prospect-panes" data-panel-open={showPanel}>
      <div className="web-prospect-results">
        <ProspectingList label="公开网页线索" selectedId={lead?.id} onSelect={id => openPanel({ kind: 'lead', id })}
          rows={items.map(item => ({
            id: item.id,
            username: sourceLabel(item),
            text: item.excerpt || item.title,
            intent: <span className="web-prospect-intent">待核实</span>,
            status: <LeadStatus lead={item} />,
          }))} />
        {!items.length && <p className="web-prospect-empty" role="status">{loading ? '正在读取搜索记录…' :
          term || filter !== 'all' ? '当前筛选下没有来源' :
            latest?.status === 'completed' && latest.resultCount === 0 ? '本次搜索成功，但未找到匹配的公开来源。可调整关键词或地区。' :
              latest ? '当前筛选下没有来源' : '尚未搜索。输入关键词后开始收集公开来源。'}</p>}
      </div>

      {panel?.kind === 'search' && <ProspectingPanel title="搜索公开网页" onClose={closePanel} className="web-prospect-detail">
        <div className="web-prospect-panel-content">
          {errorMessage}
          <form className="web-prospect-form" onSubmit={event => { event.preventDefault(); search(); }}>
            <label>关键词
              <textarea aria-label="搜索关键词" value={keywords} rows={3} maxLength={204}
                placeholder="每行一个短语，最多 5 个，如：餐饮品牌加盟"
                onChange={event => { setKeywords(event.target.value); setSearchDirty(true); }} disabled={busy} />
            </label>
            <div className="web-prospect-fields">
              <label>平台
                <select aria-label="搜索平台" value={platform} onChange={event => {
                  setPlatform(event.target.value as WebPlatform); setSearchDirty(true);
                }} disabled={busy}>{platforms.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
              </label>
              <label>地区{platform === 'tieba' ? '（必填）' : '（可选）'}
                <input aria-label="搜索地区" maxLength={60} required={platform === 'tieba'} value={region} placeholder="例如：上海"
                  onChange={event => { setRegion(event.target.value); setSearchDirty(true); }} disabled={busy} />
              </label>
            </div>
            <p className="web-prospect-hint">搜索结果来自公开索引，企业关联和采购意向需人工核实。</p>
            <button type="submit" className="web-prospect-primary" disabled={busy || loading || !keywords.trim() || platform === 'tieba' && !region.trim()}>
              <Search size={16} aria-hidden="true" />{busy ? '正在处理…' : '搜索公开网页'}
            </button>
          </form>
          {latest && <TaskStatus task={latest} />}
          <SearchHistory tasks={snapshot.tasks} />
        </div>
      </ProspectingPanel>}

      {lead && <ProspectingPanel title={lead.title || '公开线索详情'} onClose={closePanel} className="web-prospect-detail" closeLabel="关闭线索详情">
        <div className="web-prospect-panel-content">
          {errorMessage}
          <div className="web-prospect-source-actions">
            <LeadStatus lead={lead} />
            {source && <a href={source.href} target="_blank" rel="noopener noreferrer">打开公开来源 <ExternalLink size={14} aria-hidden="true" /></a>}
          </div>
          <p className="web-prospect-excerpt">{lead.excerpt || '索引未提供摘要，请查看原始来源。'}</p>
          <details className="web-prospect-disclosure" key={lead.id}>
            <summary>检索与地区证据<ChevronDown size={14} aria-hidden="true" /></summary>
            <dl>
              <dt>来源</dt><dd>{sourceLabel(lead)}</dd>
              <dt>检索词</dt><dd>{lead.query}</dd>
              <dt>获取时间</dt><dd>{dateLabel(lead.retrievedAt)}</dd>
              <dt>地区证据</dt><dd>{lead.regionMatch === 'confirmed' ? lead.regionEvidence : '未在来源标题或摘要中找到指定地区，需人工核实'}</dd>
            </dl>
          </details>
          {!lead.projectId && <div className="web-prospect-review">
            <button type="button" className={lead.status === 'qualified' ? '' : 'web-prospect-primary'} disabled={busy || lead.status === 'qualified'}
              onClick={() => review('qualified')}>标为有效线索</button>
            <button type="button" disabled={busy || lead.status === 'ignored'} onClick={() => review('ignored')}>忽略</button>
            {lead.status !== 'new' && <button type="button" disabled={busy} onClick={() => review('new')}>恢复待审核</button>}
          </div>}
          {lead.projectId ? <div className="web-prospect-review">
            <button type="button" className="web-prospect-primary" disabled={busy} onClick={() => onNavigateProject?.(lead.projectId!)}>打开已建项目</button>
          </div> : lead.status === 'qualified' && <form className="web-prospect-convert" onSubmit={event => {
            event.preventDefault();
            void execute({ action: 'convert', leadId: lead.id, version: lead.version, companyName: draft.company, projectName: draft.project,
              ...(draft.salesId ? { salesId: draft.salesId } : {}) });
          }}>
            <div><h3>建立待核实项目</h3><p className="web-prospect-hint">核对企业和项目名称后提交，公开来源会随项目保存。</p></div>
            <div className="web-prospect-fields">
              <label>企业名称<input required aria-label="企业名称" maxLength={100} value={draft.company}
                onChange={event => updateDraft({ company: event.target.value })} disabled={busy} /></label>
              <label>项目名称<input required aria-label="项目名称" maxLength={100} value={draft.project}
                onChange={event => updateDraft({ project: event.target.value })} disabled={busy} /></label>
              {needsOwner && <label>销售归属
                <select required aria-label="销售归属" value={draft.salesId} onChange={event => updateDraft({ salesId: event.target.value })} disabled={busy}>
                  <option value="">请选择归属</option>
                  {snapshot.owners?.map(owner => <option key={owner.salesId} value={owner.salesId}>{owner.displayName}</option>)}
                </select>
              </label>}
            </div>
            <button type="submit" className="web-prospect-primary"
              disabled={busy || !draft.company.trim() || !draft.project.trim() || needsOwner && !draft.salesId}>确认建立项目</button>
          </form>}
        </div>
      </ProspectingPanel>}
    </div>
  </section>;
}
