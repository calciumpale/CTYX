'use client';

import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';
import { AlertCircle, ArrowLeft, Check, ChevronDown, ClipboardCheck, Copy, FileCheck2, FileText, History, Loader2, Pencil, Plus, Save, ShieldCheck, Upload, X } from 'lucide-react';
import { CONTRACT_TYPES, type ContractDocument, type ContractFinding, type ContractFindingStatus, type ContractKind, type ContractParty, type ContractRiskLevel } from '../lib/contract-types';
import { importContractFile } from '../lib/contract-import';
import type { View, ViewProps } from '../lib/types';
import './studio.css';
import './contract-review.css';

type Draft = Pick<ContractDocument, 'dealId' | 'title' | 'text' | 'contractType' | 'ourParty' | 'focus' | 'sourceFormat' | 'fileName' | 'importWarnings'>;
type Props = ViewProps & { initialDealId?: string | null; onApproval?: (contractId:string,dealId:string)=>void; onNavigate?: (view: View, id?: string) => void; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void };
const LEVEL_LABELS: Record<ContractRiskLevel, string> = { high: '高风险', medium: '中风险', low: '低风险' };
const STATUS_LABELS: Record<ContractFindingStatus, string> = { open: '待处理', revised: '已修改', legal: '需法务确认' };
const MAX_CHARACTERS = 80000;
const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const emptyDraft = (dealId = ''): Draft => ({ dealId, title: '', text: '', contractType: '销售合同', ourParty: '待确认', focus: '', sourceFormat: 'paste', importWarnings: [] });
const documentDraft = (doc: ContractDocument): Draft => ({ dealId: doc.dealId, title: doc.title, text: doc.text, contractType: doc.contractType, ourParty: doc.ourParty, focus: doc.focus, sourceFormat: doc.sourceFormat, fileName: doc.fileName, importWarnings: doc.importWarnings ?? [] });
const signature = (draft: Draft) => JSON.stringify({ ...draft, fileName: draft.fileName || '', importWarnings: draft.importWarnings ?? [] });

/** Offsets are UTF-16 positions in the saved text; React keeps every fragment escaped. */
function MarkedContract({ text, findings, selectedId, onSelect }: { text: string; findings: ContractFinding[]; selectedId: string; onSelect: (finding: ContractFinding, locate?: boolean) => void }) {
  const fragments = useMemo(() => {
    const valid = findings.filter(item => item.start >= 0 && item.end > item.start && item.end <= text.length && text.slice(item.start, item.end) === item.quote);
    const bounds = [...new Set([0, text.length, ...valid.flatMap(item => [item.start, item.end])])].sort((a, b) => a - b);
    return bounds.slice(0, -1).map((start, index) => ({ start, text: text.slice(start, bounds[index + 1]), matches: valid.filter(item => item.start <= start && item.end >= bounds[index + 1]) }));
  }, [text, findings]);
  const activate = (event: KeyboardEvent<HTMLElement>, finding: ContractFinding) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(finding, false); } };
  return <div className="contract-original-text">{fragments.map(fragment => {
    if (!fragment.matches.length) return <span key={fragment.start}>{fragment.text}</span>;
    const finding = fragment.matches.find(item => item.id === selectedId) ?? fragment.matches[0];
    return <mark key={fragment.start} role="button" tabIndex={0} data-finding-ids={fragment.matches.map(item => item.id).join(' ')} className={`contract-highlight contract-highlight-${finding.level}${finding.id === selectedId ? ' contract-highlight-active' : ''}`} aria-label={`${LEVEL_LABELS[finding.level]}：${finding.title}`} aria-pressed={finding.id === selectedId} title={fragment.matches.map(item => item.title).join('；')} onClick={() => onSelect(finding, false)} onKeyDown={event => activate(event, finding)}>{fragment.text}</mark>;
  })}</div>;
}

function ReviewEmpty({ busy }: { busy: boolean }) {
  return <div className="contract-review-empty" aria-live="polite">{busy ? <Loader2 size={24} className="studio-spin" /> : <ShieldCheck size={24} />}<h2>{busy ? 'AI 正在初审' : '暂无初审结果'}</h2><p>{busy ? '正在分析合同条款，请稍候。' : '导入合同，选择我方立场后开始初审。'}</p></div>;
}

export function ContractReviewView({ state, mutate, notify, initialDealId, onApproval, onBusyChange, onDirtyChange }: Props) {
  const prefix = useId();
  const [saved, setSaved] = useState<ContractDocument | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(initialDealId || ''));
  const [busy, setBusy] = useState<'import' | 'save' | 'review' | 'status' | ''>('');
  const busyRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sourcePanel = useRef<HTMLDivElement>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const [error, setError] = useState('');
  const [selectedFindingId, setSelectedFindingId] = useState('');
  const [riskFilter, setRiskFilter] = useState<'all' | ContractRiskLevel>('all');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState(true);
  const [pendingDocument, setPendingDocument] = useState<ContractDocument | 'new' | null>(null);
  const documents = state.contracts ?? [];
  // Keep the version the editor loaded. A newer workspace refresh must not let a
  // stale local draft silently overwrite another reviewer's changes.
  const current = saved;
  const dirty = current ? signature(draft) !== signature(documentDraft(current)) : Boolean(draft.title.trim() || draft.text || draft.focus.trim() || draft.fileName || draft.contractType !== '销售合同' || draft.ourParty !== '待确认');
  const analysis = !dirty ? current?.analysis : undefined;
  const findings = analysis?.findings ?? [];
  const visibleFindings = findings.filter(item => riskFilter === 'all' || item.level === riskFilter);
  const selectedFinding = visibleFindings.find(item => item.id === selectedFindingId) ?? visibleFindings[0];
  const sortedDocuments = [...documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const canSave = Boolean(draft.dealId && draft.title.trim() && draft.text.trim() && draft.text.length <= MAX_CHARACTERS);
  const isBusy = Boolean(busy);

  useEffect(() => { onBusyChange?.(isBusy); return () => onBusyChange?.(false); }, [isBusy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (busyRef.current || dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => { if (!busyRef.current) { setDraft(previous => ({ ...previous, [key]: value })); setError(''); setSelectedFindingId(''); } };
  const start = (kind: typeof busy) => { if (busyRef.current) return false; busyRef.current = true; setBusy(kind); setError(''); return true; };
  const finish = () => { busyRef.current = false; setBusy(''); };
  const adopt = (doc: ContractDocument) => { setSaved(doc); setDraft(documentDraft(doc)); setEditing(!doc.analysis); setSelectedFindingId(doc.analysis?.findings[0]?.id ?? ''); setRiskFilter('all'); };
  const openDocument = (doc: ContractDocument | 'new') => {
    if (busyRef.current) return;
    if (dirty) { setPendingDocument(doc); return; }
    if (doc === 'new') { setSaved(null); setDraft(emptyDraft(initialDealId || '')); setEditing(true); setSelectedFindingId(''); setRiskFilter('all'); } else adopt(doc);
    setError(''); setPendingDocument(null); setHistoryOpen(false);
  };
  const discardAndOpen = () => {
    const next = pendingDocument;
    if (!next) return;
    if (next === 'new') { setSaved(null); setDraft(emptyDraft(initialDealId || '')); setEditing(true); setSelectedFindingId(''); setRiskFilter('all'); } else adopt(next);
    setError(''); setPendingDocument(null); setHistoryOpen(false);
  };
  const persist = async (): Promise<ContractDocument> => {
    if (current && !dirty) return current;
    const result = await mutate('contract_save', { ...draft, ...(current ? { id: current.id, version: current.version } : {}) });
    const doc = result.state.contracts?.find(item => item.id === (result.contractId || current?.id));
    if (!doc) throw new Error('合同已提交，但未能读取保存结果。请刷新历史记录后重试。');
    setSaved(doc); setDraft(documentDraft(doc));
    return doc;
  };
  const save = async () => {
    if (!canSave || !start('save')) return;
    try { await persist(); notify('合同草稿已保存'); } catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，编辑内容已保留，请重试。'); } finally { finish(); }
  };
  const review = async () => {
    if (!canSave || !state.model.connected || !start('review')) return;
    try {
      const doc = await persist();
      const result = await mutate('contract_review', { id: doc.id, version: doc.version });
      const reviewed = result.state.contracts?.find(item => item.id === doc.id);
      if (!reviewed?.analysis) throw new Error('本次初审未返回有效结果，合同草稿已保留，请重试。');
      adopt(reviewed); notify('合同初审完成，请对照原文逐条确认');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '初审失败，合同草稿已保留，请重试。'); } finally { finish(); }
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || !start('import')) return;
    try {
      const imported = await importContractFile(file);
      setDraft(previous => ({ ...previous, text: imported.text, title: previous.title || imported.fileName.replace(/\.[^.]+$/u, ''), fileName: imported.fileName, sourceFormat: imported.format, importWarnings: imported.warnings }));
      setEditing(true); setSelectedFindingId(''); notify('合同正文已导入，请核对文本后开始初审');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '文件导入失败，可改为粘贴合同正文。'); } finally { finish(); }
  };
  const selectFinding = (finding: ContractFinding, locate = true) => {
    setSelectedFindingId(finding.id);
    if (!locate) { if (window.matchMedia('(max-width: 900px)').matches) detailPanel.current?.scrollIntoView({ block: 'start' }); return; }
    setEditing(false);
    requestAnimationFrame(() => {
      const targets = sourcePanel.current?.querySelectorAll<HTMLElement>('[data-finding-ids]');
      const target = [...(targets ?? [])].find(element => element.dataset.findingIds?.split(' ').includes(finding.id));
      target?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  };
  const setFindingStatus = async (finding: ContractFinding, status: ContractFindingStatus) => {
    if (!current || !analysis || finding.status === status || !start('status')) return;
    try {
      const result = await mutate('contract_finding_status', { id: current.id, version: current.version, findingId: finding.id, status });
      const doc = result.state.contracts?.find(item => item.id === current.id);
      if (doc) setSaved(doc);
      notify(`已标记为${STATUS_LABELS[status]}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '处理状态保存失败，请重试。'); } finally { finish(); }
  };
  const copy = (text: string, label: string) => void navigator.clipboard.writeText(text).then(() => notify(`已复制${label}`)).catch(() => notify('浏览器未允许复制，请手动选择内容。'));
  const riskBadge = (level: ContractRiskLevel): ReactNode => <span className={`contract-risk-badge contract-risk-${level}`}>{LEVEL_LABELS[level]}</span>;

  return <div className="studio-view contract-review-view" aria-busy={isBusy}>
    <header className="page-header studio-heading contract-page-heading"><div><h1>AI 合同初审</h1></div><div className="contract-header-actions">{current && onApproval && <button type="button" className="studio-btn studio-btn-secondary" disabled={isBusy || dirty} title={dirty ? '请先保存合同修改' : '将当前已保存的合同提交多级审批'} onClick={() => onApproval(current.id,current.dealId)}><ClipboardCheck size={16} />提交审批</button>}<button type="button" className="studio-btn studio-btn-secondary" aria-expanded={historyOpen} disabled={isBusy} onClick={() => setHistoryOpen(value => !value)}><History size={16} />审查历史<span>{documents.length}</span></button><button type="button" className="studio-btn studio-btn-secondary" disabled={isBusy} onClick={() => openDocument('new')}><Plus size={16} />新建审查</button></div></header>

    {historyOpen && <section className="contract-history" aria-label="合同审查历史"><div className="contract-section-header"><h2>审查历史</h2><button type="button" className="studio-icon-button" aria-label="收起审查历史" onClick={() => setHistoryOpen(false)}><X size={16} /></button></div>{sortedDocuments.length ? <ul>{sortedDocuments.map(doc => { const project = state.deals.find(item => item.id === doc.dealId); return <li key={doc.id}><button type="button" className={current?.id === doc.id ? 'contract-history-active' : ''} disabled={isBusy} onClick={() => openDocument(doc)}><FileText size={18} /><span><strong>{doc.title}</strong><small>{project?.projectName || project?.name || '关联项目'} · {dateLabel(doc.updatedAt)}</small></span><span className="contract-document-status">{doc.analysis ? `${doc.analysis.findings.length} 处风险` : '草稿'}</span></button></li>; })}</ul> : <p>暂无审查记录</p>}</section>}

    {pendingDocument && <div className="contract-switch-confirm" role="alert"><p>当前合同有未保存的修改。保存后可继续切换，也可以放弃这次修改。</p><div><button type="button" className="studio-btn studio-btn-ghost" disabled={isBusy} onClick={() => setPendingDocument(null)}>继续编辑</button><button type="button" className="studio-btn studio-btn-secondary" disabled={isBusy} onClick={discardAndOpen}>放弃修改并切换</button><button type="button" className="studio-btn studio-btn-primary" disabled={isBusy || !canSave} onClick={async () => { if (!start('save')) return; try { await persist(); const next = pendingDocument; setPendingDocument(null); if (next === 'new') { setSaved(null); setDraft(emptyDraft(initialDealId || '')); setEditing(true); setSelectedFindingId(''); } else if (next) adopt(next); setHistoryOpen(false); } catch (failure) { setError(failure instanceof Error ? failure.message : '保存失败，编辑内容已保留。'); } finally { finish(); } }}>保存并切换</button></div></div>}

    <section className="contract-setup" aria-label="合同信息"><div className="contract-setup-heading"><h2>合同信息</h2><span>{dirty ? '有未保存修改' : current ? '已保存' : '新草稿'}</span></div><div className="contract-form-grid"><label htmlFor={`${prefix}-project`}>关联项目<select id={`${prefix}-project`} value={draft.dealId} disabled={isBusy} onChange={event => update('dealId', event.target.value)}><option value="">选择一个项目</option>{state.deals.map(deal => <option key={deal.id} value={deal.id}>{deal.projectName || deal.name}</option>)}</select></label><label htmlFor={`${prefix}-title`}>合同标题<input id={`${prefix}-title`} maxLength={150} value={draft.title} disabled={isBusy} placeholder="例如：年度服务采购合同" onChange={event => update('title', event.target.value)} /></label><label htmlFor={`${prefix}-type`}>合同类型<select id={`${prefix}-type`} value={draft.contractType} disabled={isBusy} onChange={event => update('contractType', event.target.value as ContractKind)}>{CONTRACT_TYPES.map(type => <option key={type}>{type}</option>)}</select></label><label htmlFor={`${prefix}-party`}>我方立场<select id={`${prefix}-party`} value={draft.ourParty} disabled={isBusy} onChange={event => update('ourParty', event.target.value as ContractParty)}><option>待确认</option><option>甲方</option><option>乙方</option></select></label><label htmlFor={`${prefix}-focus`} className="contract-focus-field">审查重点<span>选填</span><input id={`${prefix}-focus`} maxLength={2000} value={draft.focus} disabled={isBusy} placeholder="例如：付款比例、验收标准、违约责任上限" onChange={event => update('focus', event.target.value)} /></label></div><div className="contract-save-row"><div><button type="button" className="studio-btn studio-btn-secondary" disabled={isBusy || !canSave || Boolean(current && !dirty)} onClick={save}>{busy === 'save' ? <Loader2 size={15} className="studio-spin" /> : <Save size={15} />}保存草稿</button><button type="button" className="studio-btn studio-btn-primary" disabled={isBusy || !canSave || !state.model.connected} onClick={review}>{busy === 'review' ? <Loader2 size={15} className="studio-spin" /> : <FileCheck2 size={15} />}{analysis ? '重新初审' : 'AI 初审'}</button></div></div></section>

    {!state.model.connected && <div className="contract-config-notice"><AlertCircle size={17} /><p>初审需管理员配置模型。可先导入合同并保存草稿。</p></div>}
    {error && <p className="contract-error" role="alert"><AlertCircle size={17} />{error}</p>}
    {(draft.importWarnings?.length ?? 0) > 0 && <div className="contract-import-notice"><AlertCircle size={16} /><div><strong>请核对导入文本</strong>{draft.importWarnings?.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}

    <div className="contract-review-layout"><section className="contract-source-panel" ref={sourcePanel} aria-label="合同原文"><div className="contract-section-header"><div><h2>合同原文</h2><p>{draft.fileName || 'TXT、DOCX、文字 PDF'}</p></div><div>{analysis && <button type="button" className="studio-btn studio-btn-ghost" disabled={isBusy} onClick={() => setEditing(value => !value)}>{editing ? <ArrowLeft size={14} /> : <Pencil size={14} />}{editing ? '返回标注' : '编辑正文'}</button>}<button type="button" className="studio-btn studio-btn-secondary" disabled={isBusy} onClick={() => fileInput.current?.click()}>{busy === 'import' ? <Loader2 size={14} className="studio-spin" /> : <Upload size={14} />}导入文件</button><input ref={fileInput} type="file" accept=".txt,.docx,.pdf" className="studio-sr-only" onChange={importFile} disabled={isBusy} aria-label="导入 TXT、DOCX 或 PDF 合同" /></div></div>{analysis && !editing ? <MarkedContract text={draft.text} findings={findings} selectedId={selectedFinding?.id ?? ''} onSelect={selectFinding} /> : <label className="contract-text-field"><span className="studio-sr-only">合同正文</span><textarea value={draft.text} maxLength={MAX_CHARACTERS} rows={22} disabled={isBusy} placeholder={'粘贴合同正文，保留条款编号。'} onChange={event => { update('text', event.target.value); setEditing(true); }} /></label>}<footer className="contract-source-footer"><span>{draft.text.length.toLocaleString('zh-CN')} / {MAX_CHARACTERS.toLocaleString('zh-CN')} 字符</span><span>{analysis && !editing ? '点击标注查看对应修改建议' : dirty && current?.analysis ? '内容已变更，需重新初审' : '可导入 TXT、DOCX、文字 PDF'}</span></footer></section>

    <section className="contract-results-panel" aria-label="AI 合同初审结果">{analysis ? <><div className="contract-result-heading"><h2>初审意见</h2><p>{current?.reviewedAt && `${dateLabel(current.reviewedAt)} · `}{current?.modelName || 'AI 商务风控'}</p></div><p className="contract-review-summary">{analysis.summary}</p>{analysis.warnings.length > 0 && <div className="contract-analysis-warnings">{analysis.warnings.map((warning, index) => <p key={index}><AlertCircle size={14} />{warning}</p>)}</div>}<div className="contract-risk-toolbar"><div role="group" aria-label="按风险等级筛选">{(['all', 'high', 'medium', 'low'] as const).map(level => <button key={level} type="button" aria-pressed={riskFilter === level} className={riskFilter === level ? 'active' : ''} onClick={() => setRiskFilter(level)}>{level === 'all' ? '全部' : LEVEL_LABELS[level]}<span>{level === 'all' ? findings.length : findings.filter(item => item.level === level).length}</span></button>)}</div></div>{visibleFindings.length ? <div className="contract-findings-list" aria-label="风险条款列表">{visibleFindings.map(finding => <button type="button" key={finding.id} className={`contract-finding-row${selectedFinding?.id === finding.id ? ' contract-finding-selected' : ''}`} aria-pressed={selectedFinding?.id === finding.id} onClick={() => selectFinding(finding)}><span>{riskBadge(finding.level)}<strong>{finding.title}</strong></span><small>{STATUS_LABELS[finding.status]}<ChevronDown size={13} /></small></button>)}</div> : <p className="contract-no-findings"><Check size={17} />{findings.length ? '此等级暂未发现风险条款。' : '本次未识别到可定位的风险条款，仍需核对合同完整性。'}</p>}
      {selectedFinding && visibleFindings.some(item => item.id === selectedFinding.id) && <article className="contract-finding-detail" ref={detailPanel} aria-label="当前风险修改建议"><div className="contract-finding-detail-heading">{riskBadge(selectedFinding.level)}<h3>{selectedFinding.title}</h3></div><dl><div><dt>原文条款</dt><dd className="contract-quote">{selectedFinding.quote}</dd></div><div><dt>风险说明</dt><dd>{selectedFinding.reason}</dd></div><div><dt>修改建议<button type="button" className="contract-copy-button" onClick={() => copy(selectedFinding.suggestion, '修改建议')}><Copy size={13} />复制</button></dt><dd>{selectedFinding.suggestion}</dd></div>{selectedFinding.replacement && <div><dt>建议替换文本<button type="button" className="contract-copy-button" onClick={() => copy(selectedFinding.replacement, '建议替换文本')}><Copy size={13} />复制</button></dt><dd className="contract-replacement">{selectedFinding.replacement}</dd></div>}</dl><label className="contract-status-control">处理状态<select value={selectedFinding.status} disabled={isBusy} onChange={event => void setFindingStatus(selectedFinding, event.target.value as ContractFindingStatus)}>{(Object.keys(STATUS_LABELS) as ContractFindingStatus[]).map(status => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></label></article>}
      {analysis.missingItems.length > 0 && <section className="contract-missing-items"><h3><AlertCircle size={17} />待补充或确认的条款</h3>{analysis.missingItems.map(item => <article key={item.id}><h4>{item.title}</h4><p>{item.reason}</p><div><strong>建议</strong><p>{item.suggestion}</p></div></article>)}</section>}<p className="contract-review-coverage">已分析 {analysis.coverage.characters.toLocaleString('zh-CN')} 字符 · {analysis.coverage.clauses} 个条款片段</p></> : <ReviewEmpty busy={busy === 'review'} />}</section></div>
  </div>;
}
