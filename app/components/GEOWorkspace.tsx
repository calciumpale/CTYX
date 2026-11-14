'use client';

import { Check, ChevronRight, CircleAlert, Download, FileText, Plus, RotateCcw, Save, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { StudioRequestError, studioRequest } from '../lib/creative-studio-client';
import { emptyGeoDocument, GEO_STATUS_LABELS, type GeoArticle, type GeoBrief, type GeoDocument, type GeoObservation, type GeoProject, type GeoQuality, type GeoStatus, type GeoSummary } from '../lib/geo-types';
import type { MemberSession } from '../lib/member-types';
import { preferredScrollBehavior } from '../lib/scroll-behavior';
import GeoKnowledgePicker from './GeoKnowledgePicker';
import './geo-workspace.css';

const PATH = '/api/geo';
const observations = { mentioned: '有提及', not_mentioned: '未提及', unclear: '无法判断' } as const;
const timestamp = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai',
});
const initialForms = {
  reviewNote: '', url: '', channel: '', engine: '', query: '', evidence: '',
  result: '' as '' | GeoObservation['result'],
};
const readProject = (id: string) => studioRequest<{ project: GeoProject }>(`?id=${encodeURIComponent(id)}`, undefined, PATH);
const postGeo = <T,>(body: object) => studioRequest<T>('', body, PATH);

function httpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function downloadMarkdown({ brief, article }: GeoDocument) {
  const title = article.title.replace(/[\r\n]+/g, ' ').trim();
  const faq = article.faq.filter(row => row.question.trim() && row.answer.trim())
    .map(row => `### ${row.question.replace(/[\r\n]+/g, ' ').trim()}\n\n${row.answer.trim()}`);
  const sources = brief.sources.flatMap((source, index) => {
    const url = httpsUrl(source.url);
    const label = source.title.replace(/[\r\n]+/g, ' ').trim();
    if (!label || !source.excerpt.trim()) return [];
    return [`- [${index + 1}] ${label}${url ? ` — <${url}>` : ''}`];
  });
  const markdown = [
    `# ${title}`, article.summary.trim(), article.markdown.trim(),
    faq.length ? `## 常见问题\n\n${faq.join('\n\n')}` : '',
    sources.length ? `## 参考资料\n\n${sources.join('\n')}` : '',
  ].filter(Boolean).join('\n\n') + '\n';
  const href = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = `${title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 70) || 'GEO 稿件'}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function Status({ status }: { status: GeoStatus }) {
  return <span className="geo-status" data-status={status}>{GEO_STATUS_LABELS[status]}</span>;
}

function BriefEditor({ brief, onChange, onRemoveSource, editable, busy }: {
  brief: GeoBrief; onChange: (brief: GeoBrief) => void; onRemoveSource: (index: number) => void; editable: boolean; busy: boolean;
}) {
  return <fieldset className="geo-fields" disabled={busy || !editable}>
    <label>品牌<input className="input" value={brief.brand} maxLength={120} onChange={e => onChange({ ...brief, brand: e.target.value })} /></label>
    <label>选题<input className="input" value={brief.topic} maxLength={120} onChange={e => onChange({ ...brief, topic: e.target.value })} /></label>
    <label>目标受众<input className="input" value={brief.audience} maxLength={300} onChange={e => onChange({ ...brief, audience: e.target.value })} /></label>
    <label>用户主要问题<textarea className="textarea" rows={2} value={brief.question} maxLength={600}
      placeholder="例如：选择园区办公空间时，需要核对哪些条件？" onChange={e => onChange({ ...brief, question: e.target.value })} /></label>
    <div className="geo-field-heading">
      <h4>可信来源</h4>
      <button type="button" className="button ghost" disabled={brief.sources.length >= 8}
        onClick={() => onChange({ ...brief, sources: [...brief.sources, { title: '', url: '', excerpt: '' }] })}><Plus size={15} aria-hidden="true" />添加来源</button>
    </div>
    <p className="geo-muted">填写核实过的原文摘录。公开链接使用 HTTPS，内部资料可留空。正文用 [1]、[2] 对应来源编号。</p>
    {editable && <GeoKnowledgePicker disabled={busy || brief.sources.length >= 8}
      onSelect={source => onChange({ ...brief, sources: [...brief.sources, source] })} />}
    {brief.sources.map((source, index) => {
      const patch = (changes: Partial<GeoBrief['sources'][number]>) =>
        onChange({ ...brief, sources: brief.sources.map((row, position) => position === index ? { ...row, ...changes } : row) });
      return <div className="geo-entry" key={index}>
        <div className="geo-field-heading">
          <strong>来源 [{index + 1}]</strong>
          <button type="button" className="icon-button" aria-label={`移除来源 ${index + 1}`}
            onClick={() => onRemoveSource(index)}><Trash2 size={15} aria-hidden="true" /></button>
        </div>
        <label>来源标题<input className="input" value={source.title} maxLength={160} onChange={e => patch({ title: e.target.value })} /></label>
        <label>来源链接<input type="url" className="input" placeholder="https://" value={source.url} maxLength={2048} onChange={e => patch({ url: e.target.value })} /></label>
        <label>证据摘录<textarea className="textarea" rows={3} value={source.excerpt} maxLength={1800} onChange={e => patch({ excerpt: e.target.value })} /></label>
      </div>;
    })}
  </fieldset>;
}

function ArticleEditor({ article, onChange, disabled }: { article: GeoArticle; onChange: (article: GeoArticle) => void; disabled: boolean }) {
  return <fieldset className="geo-fields" disabled={disabled}>
    <label>文章标题<input className="input" value={article.title} maxLength={160} onChange={e => onChange({ ...article, title: e.target.value })} /></label>
    <label>摘要<textarea className="textarea" rows={3} value={article.summary} maxLength={500} onChange={e => onChange({ ...article, summary: e.target.value })} /></label>
    <label>正文 Markdown<textarea className="textarea geo-markdown" rows={12} value={article.markdown} maxLength={24000}
      placeholder="用标题分段，回答目标问题，并用 [1] 等编号引用资料。"
      onChange={e => onChange({ ...article, markdown: e.target.value })} /></label>
    <div className="geo-field-heading">
      <h4>常见问题</h4>
      <button type="button" className="button ghost" disabled={article.faq.length >= 10}
        onClick={() => onChange({ ...article, faq: [...article.faq, { question: '', answer: '' }] })}><Plus size={15} aria-hidden="true" />添加问答</button>
    </div>
    {article.faq.map((row, index) => {
      const patch = (changes: Partial<GeoArticle['faq'][number]>) =>
        onChange({ ...article, faq: article.faq.map((item, position) => position === index ? { ...item, ...changes } : item) });
      return <div className="geo-entry" key={index}>
        <div className="geo-field-heading">
          <strong>问答 {index + 1}</strong>
          <button type="button" className="icon-button" aria-label={`移除问答 ${index + 1}`}
            onClick={() => onChange({ ...article, faq: article.faq.filter((_, position) => position !== index) })}><Trash2 size={15} aria-hidden="true" /></button>
        </div>
        <label>问题<input className="input" value={row.question} maxLength={300} onChange={e => patch({ question: e.target.value })} /></label>
        <label>回答<textarea className="textarea" rows={3} value={row.answer} maxLength={1200} onChange={e => patch({ answer: e.target.value })} /></label>
      </div>;
    })}
  </fieldset>;
}

function Quality({ quality }: { quality: GeoQuality | null }) {
  if (!quality) return <p className="geo-muted">运行质检，核对内容结构和引用是否齐全。</p>;
  return <>
    <p className="geo-quality-score" data-ready={quality.ready}>
      <strong>{quality.score} 分</strong>{quality.ready ? '可以提交审核' : '请处理下列问题'}
    </p>
    <ul className="geo-checks">
      {quality.checks.map(check => <li key={check.id} data-passed={check.passed}>
        {check.passed ? <Check size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
        <div><strong>{check.label}</strong><p>{check.detail}</p></div>
      </li>)}
    </ul>
  </>;
}

interface Props {
  member: MemberSession;
  notify: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}

export default function GEOWorkspace({ member, notify, onDirtyChange, onBusyChange }: Props) {
  const [projects, setProjects] = useState<GeoSummary[]>([]);
  const [project, setProject] = useState<GeoProject>();
  const [draft, setDraft] = useState<GeoDocument>();
  const [checked, setChecked] = useState<{ document: GeoDocument; quality: GeoQuality }>();
  const [forms, setForms] = useState(initialForms);
  const [modelAvailable, setModelAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const listEpoch = useRef(0);
  const qualityRef = useRef<HTMLElement>(null);
  const busy = Boolean(pending);
  const changed = Boolean(draft && project && JSON.stringify(draft) !== JSON.stringify(project.document));
  const dirty = changed || Object.values(forms).some(value => value.trim().length > 0);
  const quality = checked?.document === draft ? checked?.quality ?? null : !changed && project?.version ? project.quality : null;
  const readyBrief = Boolean(draft?.brief.brand.trim() && draft.brief.topic.trim() && draft.brief.question.trim() &&
    draft.brief.sources.some(source => source.title.trim() && (!source.url.trim() || httpsUrl(source.url)) && source.excerpt.trim()));

  const loadList = useCallback(async () => {
    const epoch = ++listEpoch.current;
    setLoading(true);
    setListError('');
    try {
      const result = await studioRequest<{ projects: GeoSummary[]; modelAvailable: boolean }>('', undefined, PATH);
      if (mounted.current && epoch === listEpoch.current) {
        setProjects(result.projects);
        setModelAvailable(result.modelAvailable);
      }
    } catch (cause) {
      if (mounted.current && epoch === listEpoch.current) setListError(cause instanceof Error ? cause.message : '读取项目失败，请重试。');
    } finally {
      if (mounted.current && epoch === listEpoch.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => void loadList(), 0);
    return () => {
      mounted.current = false;
      window.clearTimeout(timer);
    };
  }, [loadList]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => {
    if (checked && checked.document === draft) {
      qualityRef.current?.scrollIntoView({ block: 'nearest', behavior: preferredScrollBehavior() });
    }
  }, [checked, draft]);

  function applyProject(next: GeoProject) {
    setProject(next);
    setDraft(next.document);
    setChecked(undefined);
    setForms(initialForms);
    setProjectsOpen(false);
  }

  function canLeave() {
    return !inFlight.current && (!dirty || window.confirm('放弃当前未保存的编辑？'));
  }

  async function run(label: string, action: () => Promise<void>, canConflict = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(label);
    setError('');
    setConflict(false);
    try { await action(); }
    catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : '操作未完成，请重试。');
      setConflict(canConflict && cause instanceof StudioRequestError && cause.status === 409);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending('');
    }
  }

  function start() {
    if (!canLeave()) return;
    applyProject({
      id: crypto.randomUUID(), version: 0, updatedAt: '', status: 'draft', document: emptyGeoDocument(),
      quality: { score: 0, ready: false, checks: [] }, reviewNote: '', observations: [],
      canEdit: true, canReview: false, canRecord: false,
    });
    setError('');
    setConflict(false);
  }

  function open(id: string, reload = false) {
    if (project?.id === id && !reload) { setProjectsOpen(false); return; }
    if (!canLeave()) return;
    void run('正在读取项目…', async () => {
      const response = await readProject(id);
      if (mounted.current) applyProject(response.project);
    });
  }

  function updateDraft(next: GeoDocument) {
    setDraft(next);
    setChecked(undefined);
  }

  function removeSource(index: number) {
    if (!draft) return;
    const removed = index + 1;
    let needsRepair = false;
    const reindex = (value: string) => value.replace(/\x60{3}[\s\S]*?\x60{3}|\x60[^\x60\r\n]*\x60|\[([1-9]\d*)\]/g, (match, reference?: string) => {
      if (!reference) return match;
      const number = Number(reference);
      if (number === removed) { needsRepair = true; return '[0]'; }
      return number > removed && number <= draft.brief.sources.length ? `[${number - 1}]` : match;
    });
    updateDraft({
      brief: { ...draft.brief, sources: draft.brief.sources.filter((_, position) => index !== position) },
      article: {
        title: reindex(draft.article.title),
        summary: reindex(draft.article.summary),
        markdown: reindex(draft.article.markdown),
        faq: draft.article.faq.map(row => ({ question: reindex(row.question), answer: reindex(row.answer) })),
      },
    });
    if (needsRepair) notify('已用 [0] 标出失去来源的引用，请替换或删除。');
  }

  function mutate(action: 'save' | 'submit' | 'review' | 'publish' | 'observe', fields: object, pendingText: string, success: string) {
    if (!project) return;
    void run(pendingText, async () => {
      const response = await postGeo<{ project: GeoProject }>({ action, id: project.id, version: project.version, ...fields });
      if (!mounted.current) return;
      const next = response.project;
      applyProject(next);
      if (loading) {
        void loadList();
      } else {
        setProjects(current => [{
          id: next.id, topic: next.document.brief.topic, title: next.document.article.title,
          status: next.status, updatedAt: next.updatedAt, mine: current.find(item => item.id === next.id)?.mine ?? true,
        }, ...current.filter(item => item.id !== next.id)]);
      }
      notify(success);
    }, true);
  }

  function generate() {
    if (!draft || !readyBrief || !modelAvailable) return;
    if ((draft.article.title || draft.article.markdown || draft.article.summary || draft.article.faq.length) &&
      !window.confirm('用新生成的稿件替换当前稿件？')) return;
    void run('正在生成稿件…', async () => {
      const { article } = await postGeo<{ article: GeoArticle }>({ action: 'generate', brief: draft.brief });
      if (!mounted.current) return;
      updateDraft({ ...draft, article });
      notify('稿件已生成，核对事实和引用后保存。');
    });
  }

  function check() {
    if (!draft) return;
    void run('正在检查稿件…', async () => {
      const { quality } = await postGeo<{ quality: GeoQuality }>({ action: 'check', document: draft });
      if (!mounted.current) return;
      setChecked({ document: draft, quality });
    });
  }

  function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = httpsUrl(forms.url.trim());
    if (!url) { setError('请填写以 https:// 开头的公开发布链接。'); return; }
    mutate('publish', { url, channel: forms.channel.trim() }, '正在登记发布…', '发布回执已登记');
  }

  function observe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { engine, query, result, evidence } = forms;
    if (!engine.trim() || !query.trim() || !result || !evidence.trim()) return;
    mutate('observe', { engine: engine.trim(), query: query.trim(), result, evidence: evidence.trim() }, '正在保存观察…', 'AI 可见性观察已记录');
  }

  return <section className="geo-workspace" aria-label="GEO 内容优化">
    <aside className="geo-projects" aria-label="GEO 项目" data-open={projectsOpen}>
      <header className="geo-field-heading">
        <h2>GEO 内容优化</h2>
        <button type="button" className="icon-button" disabled={busy} aria-label="新建 GEO 项目" title="新建 GEO 项目" onClick={start}><Plus size={18} aria-hidden="true" /></button>
      </header>
      <button type="button" className="button secondary geo-mobile-projects" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(open => !open)}>项目列表</button>
      <div className="geo-project-list">
        {loading && <p role="status" className="geo-muted">正在读取项目…</p>}
        {listError && <div role="alert" className="geo-alert">{listError}<button type="button" className="button ghost" onClick={() => void loadList()}>重试</button></div>}
        <ul aria-label={member.role === 'manager' ? '团队可见项目' : '我的项目'}>
          {project?.version === 0 && <li><button type="button" className="geo-project-button" aria-current="page" disabled={busy}
            onClick={() => setProjectsOpen(false)}><strong>{draft?.brief.topic || '未保存的稿件'}</strong><Status status="draft" /></button></li>}
          {projects.map(item => <li key={item.id}><button type="button" className="geo-project-button" aria-current={project?.id === item.id ? 'page' : undefined}
            disabled={busy} onClick={() => open(item.id)}><strong>{item.title || item.topic || '未命名项目'}</strong><Status status={item.status} /></button></li>)}
        </ul>
        {!loading && !listError && !projects.length && !project && <p className="geo-muted">已保存的稿件会显示在这里。</p>}
      </div>
    </aside>
    <div className="geo-main">
      {pending && <p role="status" className="geo-notice">{pending}</p>}
      {error && <div role="alert" className="geo-alert">{error}
        {conflict && project && <button type="button" className="button secondary" disabled={busy} onClick={() => open(project.id, true)}><RotateCcw size={15} aria-hidden="true" />读取最新版本</button>}
      </div>}
      {!project || !draft ? <div className="geo-empty">
        <FileText size={25} aria-hidden="true" />
        <h3>用可信资料回答用户的问题</h3>
        <p>整理品牌资料和可核验的引用，经质检与人工审核后导出稿件。发布后可登记回执并记录 AI 提及情况。</p>
        <button type="button" className="button primary" disabled={busy} onClick={start}><Plus size={16} aria-hidden="true" />新建内容项目</button>
      </div> : <>
        <header className="geo-header">
          <div>
            <div className="geo-title"><h3>{draft.article.title || draft.brief.topic || '新建内容项目'}</h3><Status status={project.status} /></div>
            <p className="geo-muted">{changed || !project.version ? '未保存' : `版本 ${project.version} · ${timestamp.format(new Date(project.updatedAt))}`}</p>
          </div>
          <div className="geo-actions">
            {project.canEdit && <>
              <button type="button" className="button secondary" disabled={busy} onClick={check}>检查质量</button>
              <button type="button" className="button primary" disabled={busy || !changed}
                onClick={() => mutate('save', { document: draft }, '正在保存草稿…', '草稿已保存')}><Save size={16} aria-hidden="true" />保存草稿</button>
            </>}
            {(project.status === 'approved' || project.status === 'published') &&
              <button type="button" className="button primary" disabled={busy} onClick={() => downloadMarkdown(project.document)}><Download size={16} aria-hidden="true" />导出 Markdown</button>}
          </div>
        </header>
        <div className="geo-columns">
          <section className="geo-panel" aria-label="创作资料">
            <h3>创作资料</h3>
            <BriefEditor key={project.id} brief={draft.brief} editable={project.canEdit} busy={busy}
              onChange={brief => updateDraft({ ...draft, brief })} onRemoveSource={removeSource} />
          </section>
          <section className="geo-panel" aria-label="文章稿件">
            <div className="geo-field-heading">
              <h3>文章稿件</h3>
              {project.canEdit && <button type="button" className="button secondary" disabled={busy || !modelAvailable || !readyBrief} onClick={generate}>
                <Sparkles size={16} aria-hidden="true" />AI 生成稿件
              </button>}
            </div>
            {project.canEdit && !modelAvailable && <p className="geo-muted">可手动编辑。启用工作台大模型后可以生成稿件。</p>}
            {project.canEdit && modelAvailable && !readyBrief && <p className="geo-muted">填写品牌、选题、主要问题及至少一条完整来源，即可生成稿件。</p>}
            <ArticleEditor article={draft.article} disabled={busy || !project.canEdit} onChange={article => updateDraft({ ...draft, article })} />
          </section>
        </div>
        <section className="geo-panel geo-workflow" aria-label="质检与审核" ref={qualityRef}>
          <div className="geo-field-heading">
            <h3>质检与审核</h3>
            {project.canEdit && <button type="button" className="button primary" disabled={busy || !project.version || changed || !quality?.ready}
              onClick={() => mutate('submit', {}, '正在提交审核…', '稿件已提交审核')}>提交审核<ChevronRight size={15} aria-hidden="true" /></button>}
          </div>
          {project.canEdit && changed && <p className="geo-muted">保存当前编辑并通过质检后即可提交。</p>}
          <Quality quality={quality} />
          {project.reviewNote && <div className="geo-note"><strong>审核意见</strong><p>{project.reviewNote}</p></div>}
          {project.canReview && <div className="geo-fields">
            <label>本次审核意见<textarea className="textarea" rows={3} disabled={busy} maxLength={1500} value={forms.reviewNote}
              placeholder="请写明需要修改的地方或通过依据。" onChange={e => setForms({ ...forms, reviewNote: e.target.value })} /></label>
            <div className="geo-actions">
              <button type="button" className="button secondary" disabled={busy || !forms.reviewNote.trim()}
                onClick={() => mutate('review', { decision: 'changes', note: forms.reviewNote.trim() }, '正在提交审核意见…', '已退回作者修改')}>退回修改</button>
              <button type="button" className="button primary" disabled={busy}
                onClick={() => mutate('review', { decision: 'approve', note: forms.reviewNote.trim() }, '正在保存审核结论…', '稿件已审核通过')}>审核通过</button>
            </div>
          </div>}
        </section>
        {(project.status === 'approved' || project.status === 'published') && <section className="geo-panel geo-workflow" aria-label="发布回执">
          <h3>发布回执</h3>
          {project.publication ? <dl className="geo-receipt">
            <dt>发布渠道</dt><dd>{project.publication.channel}</dd>
            <dt>发布链接</dt><dd><a href={httpsUrl(project.publication.url) || undefined} target="_blank" rel="noreferrer">{project.publication.url}</a></dd>
            <dt>登记时间</dt><dd>{timestamp.format(new Date(project.publication.recordedAt))}</dd>
          </dl> : project.canRecord && <form className="geo-fields" onSubmit={publish}>
            <p className="geo-muted">在目标渠道完成发布后，填写实际链接和渠道名称。</p>
            <div className="geo-field-pair">
              <label>发布渠道<input className="input" required disabled={busy} maxLength={120} value={forms.channel}
                placeholder="例如：企业官网" onChange={e => setForms({ ...forms, channel: e.target.value })} /></label>
              <label>发布链接<input type="url" className="input" required disabled={busy} maxLength={2048} value={forms.url}
                placeholder="https://" onChange={e => setForms({ ...forms, url: e.target.value })} /></label>
            </div>
            <div className="geo-actions"><button type="submit" className="button primary" disabled={busy || !forms.channel.trim() || !forms.url.trim()}>登记发布回执</button></div>
          </form>}
          {!project.publication && !project.canRecord && <p className="geo-muted">等待作者登记发布回执。</p>}
        </section>}
        {project.status === 'published' && <section className="geo-panel geo-workflow" aria-label="AI 可见性观察">
          <h3>AI 可见性观察</h3>
          <p className="geo-muted">记录实际查询时看到的结果。观察结论对应本次查询和证据。</p>
          {project.canRecord && <form className="geo-fields" onSubmit={observe}>
            <div className="geo-field-pair">
              <label>AI 引擎<input className="input" required disabled={busy} maxLength={120} value={forms.engine} placeholder="例如：DeepSeek" onChange={e => setForms({ ...forms, engine: e.target.value })} /></label>
              <label>观察结果<select className="select" required disabled={busy} value={forms.result} onChange={e => setForms({ ...forms, result: e.target.value as typeof forms.result })}>
                <option value="">请选择</option>
                {Object.entries(observations).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></label>
            </div>
            <label>实际查询问题<textarea className="textarea" rows={2} required disabled={busy} maxLength={600} value={forms.query} onChange={e => setForms({ ...forms, query: e.target.value })} /></label>
            <label>观察证据<textarea className="textarea" rows={3} required disabled={busy} maxLength={1500} value={forms.evidence}
              placeholder="粘贴回答片段，或记录来源链接与可复核的细节。" onChange={e => setForms({ ...forms, evidence: e.target.value })} /></label>
            <div className="geo-actions"><button type="submit" className="button primary" disabled={busy || !forms.engine.trim() || !forms.query.trim() || !forms.result || !forms.evidence.trim()}>保存观察记录</button></div>
          </form>}
          {project.observations.length > 0 ? <ul className="geo-observations">
            {project.observations.map(item => <li key={item.id}>
              <div className="geo-field-heading"><strong>{item.engine} · {observations[item.result]}</strong><time>{timestamp.format(new Date(item.recordedAt))}</time></div>
              <p><strong>查询</strong> {item.query}</p><p><strong>证据</strong> {item.evidence}</p>
            </li>)}
          </ul> : <p className="geo-muted">暂无观察记录。</p>}
        </section>}
      </>}
    </div>
  </section>;
}
