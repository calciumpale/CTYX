'use client';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Search, RefreshCw } from 'lucide-react';
import type { WebPlatform, WebProspectSnapshot } from '../lib/web-prospect-types.ts';
import './WebProspecting.css';
const platforms: {
    id: WebPlatform;
    label: string;
}[] = [{ id: 'all', label: '全网公开索引' }, { id: 'tieba', label: '百度贴吧' }, { id: 'xiaohongshu', label: '小红书' }, { id: 'zhihu', label: '知乎' }, { id: 'weibo', label: '微博' }, { id: 'other', label: '其他网站' }];
const taskLabels = { running: '搜索中', completed: '已完成', partial: '部分来源失败', failed: '搜索失败' };
export default function WebProspecting({ onDirtyChange, onBusyChange, onNavigateProject }: {
    onDirtyChange?: (b: boolean) => void;
    onBusyChange?: (b: boolean) => void;
    onNavigateProject?: (id: string) => void;
}) {
    const [snapshot, setSnapshot] = useState<WebProspectSnapshot>({ tasks: [], leads: [] }), [keywords, setKeywords] = useState(''), [region, setRegion] = useState(''), [platform, setPlatform] = useState<WebPlatform>('all'), [filter, setFilter] = useState('all'), [selected, setSelected] = useState(''), [company, setCompany] = useState(''), [project, setProject] = useState(''), [salesId, setSalesId] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [searchDirty, setSearchDirty] = useState(false);
    const identity = useRef<{
        payload: string;
        id: string;
    } | null>(null);
    const inFlight = useRef(false);
    const [drafts,setDrafts] = useState(new Map<string,{company:string;project:string}>());
    function selectLead(id:string) { if(id===selected)return; if(selected)setDrafts(previous=>new Map(previous).set(selected,{company,project})); const draft=drafts.get(id); setSelected(id); setCompany(draft?.company??''); setProject(draft?.project??''); }
    const dirty=searchDirty || !!(company.trim() || project.trim()) || [...drafts.entries()].some(([id,draft])=>id!==selected && !!(draft.company.trim() || draft.project.trim()));
    const lead = snapshot.leads.find(l => l.id === selected), latest = snapshot.tasks[0];
    useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
    useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
    useEffect(() => { let active = true; fetch('/api/web-prospects', { cache: 'no-store' }).then(async (r) => { const data = await r.json() as WebProspectSnapshot & {
        error?: string;
    }; if (!r.ok)
        throw Error(data.error || '读取失败'); if (active) {
        setSnapshot(data);
        setSelected(data.leads[0]?.id ?? '');
    } }).catch(e => { if (active)
        setError(e.message); }).finally(() => { if (active)
        setLoading(false); }); return () => { active = false; }; }, []);
    async function execute(body?: Record<string, unknown>) { if (inFlight.current)
        return; inFlight.current = true; setBusy(true); setError(''); try {
        const r = await fetch('/api/web-prospects', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
        const data = await r.json() as WebProspectSnapshot & {
            error?: string;
        };
        if (!r.ok)
            throw Error(data.error || '操作失败，请重试');
        setSnapshot(data);
        if (body?.action === 'search') {
            selectLead(data.leads[0]?.id ?? '');
            identity.current=null;
            setSearchDirty(false);
        }
        if (body?.action === 'convert') {
            setDrafts(previous=>{const next=new Map(previous);next.delete(selected);return next;});
            setCompany('');
            setProject('');
        }
        return data as WebProspectSnapshot;
    }
    catch (e) {
        setError(e instanceof Error ? e.message : '请求失败，请重试');
    }
    finally {
        setBusy(false);
        inFlight.current = false;
    } }
    function search() { const input = { keywords: keywords.split(/[\n，,]/).map(s => s.trim()).filter(Boolean), region, platform }; const payload = JSON.stringify(input); if (identity.current?.payload !== payload)
        identity.current = { payload, id: crypto.randomUUID() }; void execute({ action: 'search', ...input, requestId: identity.current!.id }); }
    const items = snapshot.leads.filter(l => filter === 'all' || l.status === filter);
    return <section className="web-prospect" aria-label="公开网页线索"><header className="web-prospect-header"><div><h2>公开网页线索</h2><p>从公开搜索索引收集来源，审核后再建立项目。</p></div><button type="button" onClick={() => void execute()} disabled={busy || loading} aria-label="刷新线索"><RefreshCw size={16}/></button></header><form className="web-prospect-form" onSubmit={e => { e.preventDefault(); search(); }}><label className="web-prospect-keywords">关键词 <textarea aria-label="搜索关键词" value={keywords} rows={2} maxLength={204} placeholder="每行一个短语，最多5个，如：餐饮品牌加盟" onChange={e => { setKeywords(e.target.value); setSearchDirty(true); }} disabled={busy}/></label><label>地区{platform === 'tieba' ? '（必填）' : '（可选）'}<input aria-label="搜索地区" maxLength={60} required={platform === 'tieba'} value={region} placeholder="例如：上海" onChange={e => { setRegion(e.target.value); setSearchDirty(true); }} disabled={busy}/></label><label>平台<select aria-label="搜索平台" value={platform} onChange={e => { setPlatform(e.target.value as WebPlatform); setSearchDirty(true); }} disabled={busy}>{platforms.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label><button type="submit" className="web-prospect-primary" disabled={busy || loading || !keywords.trim() || platform === 'tieba' && !region.trim()}><Search size={16}/>{busy ? '正在处理…' : '搜索公开网页'}</button></form><p className="web-prospect-disclaimer">结果来自公开索引，可能过时或遗漏；不代表已核实企业关联、联系方式或购买意向。地区仅在标题或摘要出现时标为匹配。</p>{error && <div className="web-prospect-error" role="alert">{error}<button onClick={() => void execute()} disabled={busy}>重新读取</button></div>}<div className="web-prospect-status" role="status">{loading ? '正在读取搜索记录…' : latest ? <><strong>{taskLabels[latest.status]}</strong><span>{latest.resultCount} 个来源 · {new Date(latest.createdAt).toLocaleString('zh-CN')}</span>{latest.errors.map((e, i) => <span key={i}>{e}</span>)}{latest.status === 'completed' && latest.resultCount === 0 && <span>本次搜索成功，但未找到匹配的公开来源。可调整关键词或地区。</span>}</> : '尚未搜索。输入关键词后开始收集公开来源。'}</div><div className="web-prospect-panes"><div className="web-prospect-list"><div className="web-prospect-list-tools"><h3>来源列表 <span>{items.length}</span></h3><select aria-label="审核筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部来源</option><option value="new">待审核</option><option value="qualified">有效线索</option><option value="ignored">已忽略</option></select></div><div className="web-prospect-list-scroll">{items.length === 0 ? <p className="web-prospect-empty">{loading ? '正在加载…' : '当前筛选下没有来源'}</p> : items.map(item => <button className="web-prospect-row" disabled={busy} aria-pressed={selected === item.id} key={item.id} onClick={() => selectLead(item.id)}><strong>{item.title}</strong><span>{new URL(item.sourceUrl).hostname} · {item.regionMatch === 'confirmed' ? '摘要地区匹配' : '地区待核实'}</span><small>{item.projectId ? '已建项目' : item.status === 'qualified' ? '有效线索' : item.status === 'ignored' ? '已忽略' : '待审核'}</small></button>)}</div></div><article className="web-prospect-detail">{lead ? <><h3>{lead.title}</h3><a href={lead.sourceUrl} target="_blank" rel="noopener noreferrer">打开公开来源 <ExternalLink size={14}/></a><p className="web-prospect-excerpt">{lead.excerpt || '索引未提供摘要，请查看原始来源。'}</p><dl><dt>检索词</dt><dd>{lead.query}</dd><dt>获取时间</dt><dd>{new Date(lead.retrievedAt).toLocaleString('zh-CN')}</dd><dt>地区证据</dt><dd>{lead.regionMatch === 'confirmed' ? lead.regionEvidence : '未在来源标题或摘要中找到指定地区，需人工核实'}</dd></dl>{!lead.projectId && <div className="web-prospect-review"><button disabled={busy || lead.status === 'qualified'} onClick={() => void execute({ action: 'review', leadId: lead.id, version: lead.version, status: 'qualified' })}>标为有效线索</button><button disabled={busy || lead.status === 'ignored'} onClick={() => void execute({ action: 'review', leadId: lead.id, version: lead.version, status: 'ignored' })}>忽略</button>{lead.status !== 'new' && <button disabled={busy} onClick={() => void execute({ action: 'review', leadId: lead.id, version: lead.version, status: 'new' })}>恢复待审核</button>}</div>}{lead.projectId ? <button onClick={() => onNavigateProject?.(lead.projectId!)}>打开已建项目</button> : lead.status === 'qualified' && <form className="web-prospect-convert" onSubmit={e => { e.preventDefault(); void execute({ action: 'convert', leadId: lead.id, version: lead.version, companyName: company, projectName: project, ...(salesId ? { salesId } : {}) }); }}><h4>建立待核实项目</h4><p>请填写你确认的企业与项目名称。来源会保留，客户事实和联系记录保持空白。</p><label>企业名称<input required aria-label="企业名称" maxLength={100} value={company} onChange={e => { setCompany(e.target.value); }} disabled={busy}/></label><label>项目名称<input required aria-label="项目名称" maxLength={100} value={project} onChange={e => { setProject(e.target.value); }} disabled={busy}/></label>{!!snapshot.owners?.length && <label>销售归属<select required aria-label="销售归属" value={salesId} onChange={e => setSalesId(e.target.value)} disabled={busy}><option value="">请选择归属</option>{snapshot.owners.map(o => <option key={o.salesId} value={o.salesId}>{o.displayName}</option>)}</select></label>}<button className="web-prospect-primary" disabled={busy || !company.trim() || !project.trim() || !!snapshot.owners?.length && !salesId}>确认建立项目</button></form>}</> : <div className="web-prospect-empty">选择一个来源查看摘要、地区证据和审核操作。</div>}</article></div>{snapshot.tasks.length > 1 && <details className="web-prospect-history"><summary>搜索记录（{snapshot.tasks.length}）</summary>{snapshot.tasks.map(t => <p key={t.id}>{t.keywords.join('、')} · {t.region || '未指定地区'} · {taskLabels[t.status]} · {t.resultCount} 个来源 · {new Date(t.createdAt).toLocaleString('zh-CN')}</p>)}</details>}</section>;
}
