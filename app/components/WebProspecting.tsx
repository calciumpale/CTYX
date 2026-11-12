'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ExternalLink, History, RefreshCw, Search } from 'lucide-react';
import type { WebPlatform, WebProspectLead, WebProspectSnapshot, WebProspectTask } from '../lib/web-prospect-types.ts';
import './WebProspecting.css';

const platforms: { id: WebPlatform; label: string }[] = [
  { id: 'all', label: '全网公开索引' }, { id: 'tieba', label: '百度贴吧' },
  { id: 'xiaohongshu', label: '小红书' }, { id: 'zhihu', label: '知乎' },
  { id: 'weibo', label: '微博' }, { id: 'other', label: '其他网站' },
];
const taskLabels = { running: '搜索中', completed: '已完成', partial: '部分来源失败', failed: '搜索失败' };
const reviewLabels = { new: '待审核', qualified: '有效线索', ignored: '已忽略' };
type Filter = 'all' | WebProspectLead['status'];
type ConversionDraft = { company: string; project: string };

function sourceHost(url: string) {
  try { return new URL(url).hostname; }
  catch { return '公开网页'; }
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
  if (tasks.length < 2) return null;
  return <details className="web-prospect-history">
    <summary><History size={16} aria-hidden="true" />搜索记录<ChevronDown size={14} aria-hidden="true" /></summary>
    <ol className="web-prospect-history-list" aria-label="搜索记录">
      {tasks.map(task => <li key={task.id}>
        <div><strong>{task.keywords.join('、')}</strong><span className="web-prospect-chip" data-state={task.status}>{taskLabels[task.status]}</span></div>
        <p>{task.region || '未指定地区'} · {task.resultCount} 个来源 · {dateLabel(task.createdAt)}</p>
      </li>)}
    </ol>
  </details>;
}

function TaskStatus({ task, loading }: { task?: WebProspectTask; loading: boolean }) {
  return <div className="web-prospect-status" role="status">
    {loading ? '正在读取搜索记录…' : task ? <>
      <div className="web-prospect-task-line">
        <strong className="web-prospect-chip" data-state={task.status}>{taskLabels[task.status]}</strong>
        <span>{task.keywords.join('、')}{task.region && ` · ${task.region}`}</span>
        <span className="web-prospect-task-total">{task.resultCount} 个来源 · {dateLabel(task.createdAt)}</span>
      </div>
      {task.errors.length > 0 && <ul>{task.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>}
      {task.status === 'completed' && task.resultCount === 0 &&
        <p>本次搜索成功，但未找到匹配的公开来源。可调整关键词或地区。</p>}
    </> : '尚未搜索。输入关键词后开始收集公开来源。'}
  </div>;
}

interface Props {
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onNavigateProject?: (id: string) => void;
}

async function readSnapshot(body?: Record<string, unknown>, fallback = '操作失败，请重试') {
  const response = await fetch('/api/web-prospects', body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const data = await response.json() as WebProspectSnapshot & { error?: string };
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

export default function WebProspecting({ onDirtyChange, onBusyChange, onNavigateProject }: Props) {
  const [snapshot, setSnapshot] = useState<WebProspectSnapshot>({ tasks: [], leads: [] });
  const [keywords, setKeywords] = useState('');
  const [region, setRegion] = useState('');
  const [platform, setPlatform] = useState<WebPlatform>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState('');
  const [company, setCompany] = useState('');
  const [project, setProject] = useState('');
  const [salesId, setSalesId] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchDirty, setSearchDirty] = useState(false);
  const [drafts, setDrafts] = useState(new Map<string, ConversionDraft>());
  const identity = useRef<{ payload: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const filterControl = useRef<HTMLSelectElement>(null);
  const returnToQueue = useRef<HTMLButtonElement>(null);
  const items = snapshot.leads.filter(item => filter === 'all' || item.status === filter);
  const lead = items.find(item => item.id === selected);
  const latest = snapshot.tasks[0];
  const needsOwner = Boolean(snapshot.owners?.length);
  const dirty = searchDirty || Boolean(company.trim() || project.trim()) ||
    [...drafts.entries()].some(([id, draft]) => id !== selected && Boolean(draft.company.trim() || draft.project.trim()));

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
      if (active) { setSnapshot(data); setSelected(data.leads[0]?.id ?? ''); }
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '读取失败');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  function selectLead(id: string) {
    if (id === selected) return;
    if (selected) setDrafts(previous => new Map(previous).set(selected, { company, project }));
    const draft = drafts.get(id);
    setSelected(id);
    setCompany(draft?.company ?? '');
    setProject(draft?.project ?? '');
  }

  async function execute(body?: Record<string, unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await readSnapshot(body);
      setSnapshot(data);
      if (body?.action === 'search') {
        selectLead(data.leads.find(item => filter === 'all' || item.status === filter)?.id ?? '');
        identity.current = null;
        setSearchDirty(false);
      }
      if (body?.action === 'convert') {
        setDrafts(previous => {
          const next = new Map(previous);
          next.delete(selected);
          return next;
        });
        setCompany('');
        setProject('');
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

  function openLead(id: string) {
    selectLead(id);
    requestAnimationFrame(() => {
      if (!returnToQueue.current?.getClientRects().length) return;
      detailHeading.current?.focus({ preventScroll: true });
      detailHeading.current?.scrollIntoView({ block: 'start' });
    });
  }

  function review(next: WebProspectLead['status']) {
    if (!lead) return;
    void execute({ action: 'review', leadId: lead.id, version: lead.version, status: next });
  }

  return <section className="web-prospect" aria-label="公开网页线索">
    <header className="web-prospect-header">
      <div><h2>公开网页线索</h2><p>搜索公开索引，核对来源后建立项目。</p></div>
      <div className="web-prospect-tools">
        <SearchHistory tasks={snapshot.tasks} />
        <button type="button" onClick={() => void execute()} disabled={busy || loading} aria-label="刷新线索" title="刷新线索"><RefreshCw size={16} aria-hidden="true" /></button>
      </div>
    </header>

    <section className="web-prospect-search" aria-label="搜索条件">
      <form className="web-prospect-form" onSubmit={event => { event.preventDefault(); search(); }}>
        <label className="web-prospect-keywords">关键词
          <textarea aria-label="搜索关键词" value={keywords} rows={2} maxLength={204}
            placeholder="每行一个短语，最多 5 个，如：餐饮品牌加盟"
            onChange={event => { setKeywords(event.target.value); setSearchDirty(true); }} disabled={busy} />
        </label>
        <label>平台
          <select aria-label="搜索平台" value={platform} onChange={event => {
            setPlatform(event.target.value as WebPlatform); setSearchDirty(true);
          }} disabled={busy}>{platforms.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        </label>
        <label>地区{platform === 'tieba' ? '（必填）' : '（可选）'}
          <input aria-label="搜索地区" maxLength={60} required={platform === 'tieba'} value={region} placeholder="例如：上海"
            onChange={event => { setRegion(event.target.value); setSearchDirty(true); }} disabled={busy} />
        </label>
        <button type="submit" className="web-prospect-primary" disabled={busy || loading || !keywords.trim() || platform === 'tieba' && !region.trim()}>
          <Search size={16} aria-hidden="true" />{busy ? '正在处理…' : '搜索公开网页'}
        </button>
      </form>
      <p className="web-prospect-disclaimer">公开索引可能过时或遗漏。请核对企业关联与采购意向，地区匹配仅依据标题或摘要。</p>
      <TaskStatus task={latest} loading={loading} />
    </section>

    {error && <div className="web-prospect-error" role="alert"><span>{error}</span><button type="button" onClick={() => void execute()} disabled={busy}>重新读取</button></div>}

    <div className="web-prospect-panes">
      <section className="web-prospect-list" aria-label="来源审核队列">
        <div className="web-prospect-list-tools">
          <h3>审核队列 <span>{items.length}</span></h3>
          <select aria-label="审核筛选" value={filter} ref={filterControl} disabled={busy} onChange={event => setFilter(event.target.value as Filter)}>
            <option value="all">全部来源</option>
            <option value="new">待审核</option>
            <option value="qualified">有效线索</option>
            <option value="ignored">已忽略</option>
          </select>
        </div>
        <div className="web-prospect-list-scroll">
          {items.length === 0
            ? <p className="web-prospect-empty">{loading ? '正在加载…' : latest || filter !== 'all' ? '当前筛选下没有来源' : '搜索后，公开来源会显示在这里。'}</p>
            : <ul>{items.map(item => <li key={item.id}>
              <button type="button" className="web-prospect-row" disabled={busy} aria-pressed={selected === item.id} onClick={() => openLead(item.id)}>
                <strong>{item.title}</strong>
                <span className="web-prospect-row-meta">{sourceHost(item.sourceUrl)} · {item.regionMatch === 'confirmed' ? '摘要地区匹配' : '地区待核实'}</span>
                <LeadStatus lead={item} />
              </button>
            </li>)}</ul>}
        </div>
      </section>

      <article className="web-prospect-detail" aria-label="来源详情">
        {lead ? <>
          <button type="button" className="web-prospect-return" ref={returnToQueue} onClick={() => {
            filterControl.current?.focus({ preventScroll: true });
            filterControl.current?.scrollIntoView({ block: 'start' });
          }}><ArrowLeft size={15} aria-hidden="true" />返回审核队列</button>
          <div className="web-prospect-detail-title">
            <div><LeadStatus lead={lead} /><h3 tabIndex={-1} ref={detailHeading}>{lead.title}</h3></div>
            <a href={lead.sourceUrl} target="_blank" rel="noopener noreferrer">打开公开来源 <ExternalLink size={14} aria-hidden="true" /></a>
          </div>
          <p className="web-prospect-excerpt">{lead.excerpt || '索引未提供摘要，请查看原始来源。'}</p>
          <details className="web-prospect-evidence" key={lead.id}>
            <summary>检索与地区证据<ChevronDown size={14} aria-hidden="true" /></summary>
            <dl>
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
            void execute({ action: 'convert', leadId: lead.id, version: lead.version, companyName: company, projectName: project, ...(salesId ? { salesId } : {}) });
          }}>
            <div><h4>建立待核实项目</h4><p>填写已核对的企业和项目名称，当前来源会随项目保存。</p></div>
            <div className="web-prospect-convert-fields">
              <label>企业名称<input required aria-label="企业名称" maxLength={100} value={company} onChange={event => setCompany(event.target.value)} disabled={busy} /></label>
              <label>项目名称<input required aria-label="项目名称" maxLength={100} value={project} onChange={event => setProject(event.target.value)} disabled={busy} /></label>
              {needsOwner && <label>销售归属
                <select required aria-label="销售归属" value={salesId} onChange={event => setSalesId(event.target.value)} disabled={busy}>
                  <option value="">请选择归属</option>
                  {snapshot.owners?.map(owner => <option key={owner.salesId} value={owner.salesId}>{owner.displayName}</option>)}
                </select>
              </label>}
            </div>
            <button type="submit" className="web-prospect-primary" disabled={busy || !company.trim() || !project.trim() || needsOwner && !salesId}>确认建立项目</button>
          </form>}
        </> : <div className="web-prospect-empty">选择一个来源查看摘要、地区证据和审核操作。</div>}
      </article>
    </div>
  </section>;
}
