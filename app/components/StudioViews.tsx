'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, BookOpen, Bot, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, Code2, Database, FileText, GitBranch, GraduationCap, Grip, History, Info, Layers, Link2, Loader2, MessageSquare, Play, Plus, RotateCcw, Save, Search, Send, ShieldCheck, Sparkles, Square, Trash2, Upload, X } from 'lucide-react';
import './studio.css';
import { AGENTS, type ApiResult, type FlowNode, type Mutate, type NodeType, type Run, type Skill, type ViewProps, type Workflow } from '../lib/types';

const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const durationLabel = (duration: number) => duration < 1000 ? `${Math.round(duration)} ms` : `${(duration / 1000).toFixed(1)} s`;
const agentName = (id: string) => AGENTS.find(agent => agent.id === id)?.name ?? id;
const cloneWorkflow = (workflow: Workflow): Workflow => ({ ...workflow, nodes: workflow.nodes.map(node => ({ ...node })), edges: workflow.edges.map(edge => ({ ...edge })) });

function useMutation(mutate: Mutate) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const perform = useCallback(async (action: string, payload?: Record<string, unknown>): Promise<ApiResult | null> => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setError('');
    try { return await mutate(action, payload); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '操作未完成，请重试。'); return null; }
    finally { running.current = false; setBusy(false); }
  }, [mutate]);
  return { busy, error, setError, perform };
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`studio-notice${error ? ' studio-notice-error' : ''}`} role={error ? 'alert' : 'status'}><Info size={16} /><span>{children}</span></div>;
}
function Empty({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="studio-empty">{icon}<h3>{title}</h3><p>{detail}</p></div>;
}
function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <header className="studio-heading"><div><span className="studio-eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{children && <div className="studio-heading-action">{children}</div>}</header>;
}
function BusyIcon({ busy, children }: { busy: boolean; children: ReactNode }) { return busy ? <Loader2 size={16} className="studio-spin" /> : children; }
function ModeTag({ mode, configured = false }: { mode: 'demo' | 'live'; configured?: boolean }) { return <span className={`studio-tag${mode === 'live' ? ' studio-tag-live' : ''}`}><span className="studio-status-dot" />{mode === 'demo' ? '规则演示' : configured ? '接口已配置' : '模型生成'}</span>; }

const SCENARIOS = [
  { name: '免租期异议', icon: <ShieldCheck size={22} />, tag: '商务谈判', detail: '客户要求延长免租期，练习澄清诉求、交换条件与授权边界。', duration: '建议 3–5 轮' },
  { name: '竞品比较', icon: <Layers size={22} />, tag: '价值沟通', detail: '面对竞品价格，练习比较口径、差异价值与证据表达。', duration: '建议 3–5 轮' },
  { name: '首访剧本', icon: <MessageSquare size={22} />, tag: '客户拜访', detail: '用一次自然对话，练习开场、需求探索与下一步约定。', duration: '建议 4–6 轮' },
];

export function TrainingView({ state, mutate, notify }: ViewProps) {
  const { busy, error, perform } = useMutation(mutate);
  const [scenario, setScenario] = useState(SCENARIOS[0].name);
  const [sessionId, setSessionId] = useState<string | null>(() => state.trainingSessions.find(session => session.status === 'active')?.id ?? null);
  const [reply, setReply] = useState('');
  const session = state.trainingSessions.find(item => item.id === sessionId);
  const history = [...state.trainingSessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const chatRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastScroll = useRef(0);
  useEffect(() => {
    const container = chatRef.current;
    if (container && pinned.current && Date.now() - lastScroll.current > 150) container.scrollTop = container.scrollHeight;
  }, [session?.messages.length, sessionId]);
  const start = async () => {
    const result = await perform('training_start', { scenario });
    if (result?.session) { setSessionId(result.session.id); setReply(''); pinned.current = true; notify('带练已开始，可以像面对客户一样自然回应。'); }
  };
  const sendReply = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!session || !reply.trim() || busy) return;
    const result = await perform('training_reply', { sessionId: session.id, text: reply.trim() });
    if (result) setReply('');
  };
  const finish = async () => {
    if (!session) return;
    const result = await perform('training_finish', { sessionId: session.id });
    if (result) notify('本次带练已完成，复盘已保存。');
  };
  return <section className="studio-view">
    <PageHeading eyebrow="PRACTICE MAKES PROGRESS" title="下一次沟通，先练习一次" description="培训带练专家扮演客户，陪你把关键时刻说得更好。"><span className="studio-example"><GraduationCap size={15} />规则演示带练 · 示例客户</span></PageHeading>
    {error && <Notice error>{error}</Notice>}
    <div className="studio-training-layout">
      <main className="studio-training-main">
        {!session ? <>
          <div className="studio-section-label">选择这次想练习的场景</div>
          <div className="studio-scenario-grid">{SCENARIOS.map(item => <button key={item.name} type="button" className={`studio-scenario${scenario === item.name ? ' studio-scenario-selected' : ''}`} onClick={() => setScenario(item.name)} aria-pressed={scenario === item.name}><div className="studio-scenario-top"><span className="studio-icon-clay">{item.icon}</span><span>{item.tag}</span>{scenario === item.name && <Check size={17} />}</div><h3>{item.name}</h3><p>{item.detail}</p><small>{item.duration}</small></button>)}</div>
          <div className="studio-training-start"><p><Sparkles size={16} />基于业务场景的规则演示，每次对话都留有复盘依据。</p><button className="studio-btn studio-btn-primary" disabled={busy} onClick={start}><BusyIcon busy={busy}><Play size={16} /></BusyIcon>开始带练</button></div>
          <div className="studio-training-guide"><span className="studio-guide-number">01</span><div><h3>把这里当成客户现场</h3><p>先回应客户，再逐步澄清需求、给出依据、推动下一步。完成后查看逐项反馈。</p></div></div>
        </> : <div className="studio-session-panel">
          <div className="studio-session-head"><div className="studio-row"><span className="studio-icon-clay"><GraduationCap size={22} /></span><div><h2>{session.scenario}</h2><p>{session.customer} · {session.status === 'active' ? '客户角色对话' : '已完成的练习'}</p></div></div><button className="studio-btn studio-btn-ghost" disabled={busy} onClick={() => { setSessionId(null); setReply(''); }}>选择场景<ChevronRight size={15} /></button></div>
          <div className="studio-training-chat" ref={chatRef} onScroll={event => { const target = event.currentTarget; pinned.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48; lastScroll.current = Date.now(); }} aria-live="polite" aria-relevant="additions text">
            {session.messages.map((message, index) => <div className={`studio-training-message studio-training-${message.role}`} key={`${session.id}-${index}`}><span>{message.role === 'user' ? '我的回应' : session.customer}</span><p>{message.content}</p></div>)}
            {busy && session.status === 'active' && <div className="studio-training-thinking"><Loader2 size={15} className="studio-spin" /> 正在处理本轮练习…</div>}
          </div>
          {session.status === 'active' ? <div className="studio-training-bottom"><form className="studio-reply-composer" onSubmit={sendReply}><label className="studio-sr-only" htmlFor="training-reply">输入你的回应</label><textarea id="training-reply" rows={3} value={reply} onChange={event => setReply(event.target.value)} placeholder="试着回应客户的顾虑…" maxLength={4000} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendReply(); } }} /><div><span>Enter 发送 · Shift + Enter 换行</span><button type="submit" className="studio-send" disabled={busy || !reply.trim()} aria-label="发送回应"><BusyIcon busy={busy}><ArrowUp size={18} /></BusyIcon></button></div></form><div className="studio-training-footer"><span>{session.messages.filter(message => message.role === 'user').length} 轮回应 · 可随时结束并复盘</span><button className="studio-btn studio-btn-secondary" disabled={busy} onClick={finish}><CheckCheck size={15} />结束并复盘</button></div></div> : <div className="studio-feedback"><div className="studio-score"><div><span className="studio-eyebrow">本次练习复盘</span><h3>从证据中找到下一次的进步</h3><p>规则演示评分，仅依据本次对话文本，不代表真实销售能力测评。</p></div><div className="studio-score-value">{session.score ?? '—'}<small>/ 100</small></div></div>{session.feedback?.map(item => <div className="studio-feedback-item" key={item.label}><div><strong>{item.label}</strong><span>{item.score} 分</span></div><p><b>对话依据</b>{item.evidence}</p><p><b>下次试试</b>{item.suggestion}</p></div>)}</div>}
        </div>}
      </main>
      <aside className="studio-training-aside"><div className="studio-aside-heading"><History size={17} /><h2>我的练习记录</h2><span>{history.length}</span></div>{history.length ? <div className="studio-history-list">{history.map(item => <button className={`studio-history-item${sessionId === item.id ? ' studio-history-active' : ''}`} key={item.id} disabled={busy} onClick={() => { setSessionId(item.id); setReply(''); pinned.current = true; }}><div><strong>{item.scenario}</strong><span className="studio-history-score">{item.status === 'completed' ? `${item.score ?? '—'} 分` : '进行中'}</span></div><small>{dateLabel(item.createdAt)} · {item.messages.filter(message => message.role === 'user').length} 轮</small></button>)}</div> : <Empty icon={<History size={26} />} title="练习从这里开始" detail="完成一次带练，你的对话和复盘会保存在这里。" />}<div className="studio-side-note"><CircleHelp size={17} /><p>示例客户由系统扮演。请勿输入真实客户隐私或未经授权的商务信息。</p></div></aside>
    </div>
  </section>;
}

type KnowledgeTab = 'knowledge' | 'skills' | 'review';
type KnowledgeForm = { title: string; content: string; category: string };
type CandidateForm = { title: string; description: string; scenario: string; steps: string; boundaries: string; evidence: string; source: string; dealId: string };
const emptyCandidate = (): CandidateForm => ({ title: '', description: '', scenario: '', steps: '', boundaries: '', evidence: '', source: '', dealId: '' });
const skillStatus = (status: Skill['status']) => ({ candidate: '待审核', published: '已生效', rejected: '已退回' })[status];

export function KnowledgeView({ state, mutate, notify }: ViewProps) {
  const manager = state.role === 'manager';
  const { busy, error, setError, perform } = useMutation(mutate);
  const [tab, setTab] = useState<KnowledgeTab>('knowledge');
  const [reviewStatus, setReviewStatus] = useState<'candidate' | 'rejected'>('candidate');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部分类');
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<'knowledge' | 'candidate' | null>(null);
  const [knowledgeForm, setKnowledgeForm] = useState<KnowledgeForm>({ title: '', content: '', category: '业务知识' });
  const [candidateForm, setCandidateForm] = useState<CandidateForm>(emptyCandidate);
  const [reviewNote, setReviewNote] = useState('');
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const query = search.trim().toLowerCase();
  const skillPool = state.skills.filter(skill => tab === 'review' ? skill.status === reviewStatus : skill.status === 'published');
  const knowledgePool = state.knowledge.filter(item => item.status === 'published');
  const categories = ['全部分类', ...new Set((tab === 'knowledge' ? knowledgePool : skillPool).map(item => item.category))];
  const knowledgeItems = knowledgePool.filter(item => (category === '全部分类' || item.category === category) && `${item.title} ${item.category} ${item.content} ${item.source}`.toLowerCase().includes(query));
  const skillItems = skillPool.filter(item => (category === '全部分类' || item.category === category) && `${item.title} ${item.description} ${item.scenario} ${item.steps.join(' ')} ${item.boundaries.join(' ')} ${item.evidence} ${item.source} ${item.reviewer ?? ''} ${item.reviewNote ?? ''}`.toLowerCase().includes(query));
  const selectedKnowledge = knowledgeItems.find(item => item.id === selectedId) ?? knowledgeItems[0];
  const selectedSkill = skillItems.find(item => item.id === selectedId) ?? skillItems[0];
  const switchTab = (value: KnowledgeTab) => { setTab(value); setReviewStatus('candidate'); setCategory('全部分类'); setSelectedId(''); setForm(null); setReviewNote(''); setError(''); };
  const addKnowledge = async (event: FormEvent) => {
    event.preventDefault();
    const result = await perform('knowledge_add', { ...knowledgeForm, title: knowledgeForm.title.trim(), content: knowledgeForm.content.trim() });
    if (result) { setForm(null); setKnowledgeForm({ title: '', content: '', category: '业务知识' }); setFileName(''); setSearch(''); setCategory('全部分类'); setSelectedId(result.state.knowledge.find(item => !state.knowledge.some(old => old.id === item.id))?.id ?? ''); notify('知识已导入并生效。'); }
  };
  const addCandidate = async (event: FormEvent) => {
    event.preventDefault();
    const result = await perform('skill_candidate', { ...candidateForm, dealId: candidateForm.dealId || undefined, steps: candidateForm.steps.split('\n').map(line => line.trim()).filter(Boolean), boundaries: candidateForm.boundaries.split('\n').map(line => line.trim()).filter(Boolean) });
    if (result) { setForm(null); setCandidateForm(emptyCandidate()); setTab('review'); setReviewStatus('candidate'); setCategory('全部分类'); setSearch(''); setSelectedId(result.state.skills.find(item => !state.skills.some(old => old.id === item.id))?.id ?? ''); notify('候选 Skill 已提交，等待管理者本人审核。'); }
  };
  const reviewSkill = async (decision: 'publish' | 'reject') => {
    if (!selectedSkill || !reviewNote.trim()) { setError('请先填写审核意见，说明发布依据或需要补充的内容。'); return; }
    const result = await perform('skill_review', { skillId: selectedSkill.id, decision, note: reviewNote.trim(), version: selectedSkill.version });
    if (result) { setReviewNote(''); if (decision === 'reject') { setReviewStatus('rejected'); setCategory('全部分类'); } notify(decision === 'publish' ? 'Skill 已由你审核发布，生效知识已同步。' : '候选 Skill 已退回并保存审核意见。'); }
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(txt|md|markdown)$/i.test(file.name)) { setError('仅支持 UTF-8 文本或 Markdown 文件（.txt / .md / .markdown）。'); return; }
    if (file.size > 250000) { setError('文件过大，请导入 50,000 字以内的文本内容。'); return; }
    try { const content = await file.text(); if (content.length > 50000) { setError('内容超过 50,000 字，请拆分后导入。'); return; } setKnowledgeForm(previous => ({ ...previous, title: previous.title || file.name.replace(/\.[^.]+$/, ''), content })); setFileName(file.name); setError(''); }
    catch { setError('无法读取文件，请检查编码或直接粘贴文本。'); }
  };
  return <section className="studio-view">
    <PageHeading eyebrow="FROM EXPERIENCE TO EXPERTISE" title="让好经验，成为团队的能力" description="有依据的知识，经过审核的 Skill，在下一次实战中复用。"><div className="studio-row">{manager && <button className="studio-btn studio-btn-secondary" onClick={() => { setForm('knowledge'); setError(''); }}><Upload size={16} />导入知识</button>}<button className="studio-btn studio-btn-primary" onClick={() => { setForm('candidate'); setError(''); }}><Plus size={16} />提交经验</button></div></PageHeading>
    {error && <Notice error>{error}</Notice>}
    <div className="studio-tabs" role="tablist" aria-label="知识与技能类型"><button role="tab" aria-selected={tab === 'knowledge'} className={tab === 'knowledge' ? 'studio-tab-active' : ''} onClick={() => switchTab('knowledge')}><BookOpen size={17} />知识库<span>{knowledgePool.length}</span></button><button role="tab" aria-selected={tab === 'skills'} className={tab === 'skills' ? 'studio-tab-active' : ''} onClick={() => switchTab('skills')}><Sparkles size={17} />Skill 库<span>{state.skills.filter(item => item.status === 'published').length}</span></button><button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'studio-tab-active' : ''} onClick={() => switchTab('review')}><ShieldCheck size={17} />{manager ? '审核中心' : '候选记录'}<span>{state.skills.filter(item => item.status === 'candidate').length}</span></button></div>
    {form ? <div className="studio-form-panel"><div className="studio-panel-heading"><div><h2>{form === 'knowledge' ? '导入团队知识' : '把一次好实践，提交为候选 Skill'}</h2><p>{form === 'knowledge' ? '支持直接粘贴文本，或读取本地文本 / Markdown 文件。确认后立即生效。' : '保留原始证据、操作步骤和适用边界。提交后由管理者本人决定是否发布。'}</p></div><button className="studio-icon-button" onClick={() => setForm(null)} aria-label="关闭表单" disabled={busy}><X size={19} /></button></div>
      {form === 'knowledge' && manager ? <form onSubmit={addKnowledge} className="studio-form"><div className="studio-import-zone"><FileText size={25} /><div><strong>{fileName || '选择文本或 Markdown 文件'}</strong><p>仅 .txt、.md、.markdown · 最多 50,000 字</p></div><button type="button" className="studio-btn studio-btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={15} />选择文件</button><input ref={fileRef} className="studio-sr-only" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} aria-label="导入文本或 Markdown 文件" /></div><div className="studio-form-row"><label>知识标题<input required maxLength={150} value={knowledgeForm.title} onChange={event => setKnowledgeForm({ ...knowledgeForm, title: event.target.value })} placeholder="例如：商务条款与免租期授权规范" /></label><label>分类<input required maxLength={40} value={knowledgeForm.category} onChange={event => setKnowledgeForm({ ...knowledgeForm, category: event.target.value })} /></label></div><label>知识正文<textarea required rows={13} maxLength={50000} value={knowledgeForm.content} onChange={event => setKnowledgeForm({ ...knowledgeForm, content: event.target.value })} placeholder="粘贴知识正文，保留来源、适用范围和更新时间…" /><small>{knowledgeForm.content.length.toLocaleString()} / 50,000 字</small></label><div className="studio-form-actions"><button type="button" className="studio-btn studio-btn-ghost" onClick={() => setForm(null)} disabled={busy}>取消</button><button className="studio-btn studio-btn-primary" disabled={busy || !knowledgeForm.title.trim() || !knowledgeForm.content.trim()}><BusyIcon busy={busy}><Check size={16} /></BusyIcon>确认导入并生效</button></div></form> : <form onSubmit={addCandidate} className="studio-form"><div className="studio-form-row"><label>经验名称<input required maxLength={150} value={candidateForm.title} onChange={event => setCandidateForm({ ...candidateForm, title: event.target.value })} placeholder="为这次有效做法起一个清晰的名字" /></label><label>关联商机（可选）<select value={candidateForm.dealId} onChange={event => setCandidateForm({ ...candidateForm, dealId: event.target.value })}><option value="">不关联商机</option>{state.deals.map(deal => <option key={deal.id} value={deal.id}>{deal.name}</option>)}</select></label></div><label>经验摘要<input required maxLength={1000} value={candidateForm.description} onChange={event => setCandidateForm({ ...candidateForm, description: event.target.value })} placeholder="做了什么，解决了什么问题" /></label><label>适用场景<textarea required rows={2} maxLength={2000} value={candidateForm.scenario} onChange={event => setCandidateForm({ ...candidateForm, scenario: event.target.value })} placeholder="在什么客户、阶段或条件下可以使用？" /></label><div className="studio-form-row"><label>操作步骤（每行一步）<textarea required rows={5} maxLength={5000} value={candidateForm.steps} onChange={event => setCandidateForm({ ...candidateForm, steps: event.target.value })} placeholder={'先澄清客户的具体诉求\n用证据说明方案价值\n确认双方的下一步动作'} /></label><label>适用边界（每行一条）<textarea required rows={5} maxLength={5000} value={candidateForm.boundaries} onChange={event => setCandidateForm({ ...candidateForm, boundaries: event.target.value })} placeholder={'未经批准不承诺商务条件\n缺少关键事实时先补充信息'} /></label></div><label>原始案例证据<textarea required rows={4} maxLength={5000} value={candidateForm.evidence} onChange={event => setCandidateForm({ ...candidateForm, evidence: event.target.value })} placeholder="写下可核查的对话原文、过程和实际结果；区分事实与推断。" /></label><label>证据来源<input required maxLength={1000} value={candidateForm.source} onChange={event => setCandidateForm({ ...candidateForm, source: event.target.value })} placeholder="例如：客户拜访记录，2026-10-20；或运行记录编号" /></label><div className="studio-form-actions"><span><ShieldCheck size={14} />提交后不会自动发布</span><button type="button" className="studio-btn studio-btn-ghost" disabled={busy} onClick={() => setForm(null)}>取消</button><button className="studio-btn studio-btn-primary" disabled={busy}><BusyIcon busy={busy}><Send size={15} /></BusyIcon>提交候选 Skill</button></div></form>}
    </div> : <>
      <div className="studio-filterbar"><label className="studio-search"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={tab === 'knowledge' ? '搜索知识标题、正文或来源' : '搜索场景、步骤或案例证据'} aria-label="全文搜索知识和技能" />{search && <button className="studio-icon-button" onClick={() => setSearch('')} aria-label="清空搜索"><X size={15} /></button>}</label><label className="studio-category"><span className="studio-sr-only">筛选分类</span><select value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item}>{item}</option>)}</select></label>{tab === 'review' && <label className="studio-category"><span className="studio-sr-only">筛选审核状态</span><select value={reviewStatus} onChange={event => { setReviewStatus(event.target.value as 'candidate' | 'rejected'); setCategory('全部分类'); setSelectedId(''); setReviewNote(''); }}><option value="candidate">待审核</option><option value="rejected">已退回</option></select></label>}<span className="studio-result-count">{tab === 'knowledge' ? knowledgeItems.length : skillItems.length} 条内容</span></div>
      {tab === 'review' && <Notice>{reviewStatus === 'rejected' ? '已退回的 Skill 尚未生效。查看详情中的审核人与审核意见，核对需要补充的证据和适用边界。' : manager ? '每个候选都需要你亲自核对证据与适用边界，填写审核意见后再发布或退回。' : '候选 Skill 正在等待管理者审核，通过后才会进入生效知识和 Agent 引用范围。'}</Notice>}
      <div className="studio-library-layout"><div className="studio-library-list">{tab === 'knowledge' ? knowledgeItems.length ? knowledgeItems.map(item => <button key={item.id} className={`studio-library-item${selectedKnowledge?.id === item.id ? ' studio-library-item-active' : ''}`} onClick={() => setSelectedId(item.id)}><div><BookOpen size={18} /><span>{item.category}</span></div><h3>{item.title}</h3><p>{item.content.slice(0, 90)}</p><small>{dateLabel(item.updatedAt)}<ChevronRight size={15} /></small></button>) : <Empty icon={<Search size={26} />} title="没有找到相关知识" detail="换一个关键词或分类，也可以导入新的团队知识。" /> : skillItems.length ? skillItems.map(item => <button key={item.id} className={`studio-library-item${selectedSkill?.id === item.id ? ' studio-library-item-active' : ''}`} onClick={() => { setSelectedId(item.id); setReviewNote(''); }}><div><Sparkles size={18} /><span>{item.category}</span><span className="studio-tag">{skillStatus(item.status)}</span></div><h3>{item.title}</h3><p>{item.description}</p><small>{item.author} · v{item.version}<ChevronRight size={15} /></small></button>) : <Empty icon={tab === 'review' ? <ShieldCheck size={28} /> : <Sparkles size={28} />} title={query ? '没有找到相关 Skill' : tab === 'review' ? reviewStatus === 'rejected' ? '暂无已退回的经验' : '暂无待审核的经验' : '暂无生效的 Skill'} detail={query ? '试试其他场景关键词，或切换分类。' : '有效经验提交并经管理者审核后，会在这里沉淀。'} />}</div>
        <article className="studio-library-detail">{tab === 'knowledge' ? selectedKnowledge ? <><div className="studio-detail-kicker"><span className="studio-tag">{selectedKnowledge.category}</span><span><Check size={13} />已生效</span></div><h2>{selectedKnowledge.title}</h2><div className="studio-detail-meta">来源：{selectedKnowledge.source} · 更新于 {dateLabel(selectedKnowledge.updatedAt)}</div><div className="studio-document-content">{selectedKnowledge.content}</div></> : <Empty icon={<BookOpen size={32} />} title="让每一次回答都有依据" detail="从左侧选择知识，阅读完整内容与来源。" /> : selectedSkill ? <><div className="studio-detail-kicker"><span className="studio-tag">{skillStatus(selectedSkill.status)}</span><span>Skill · v{selectedSkill.version}</span></div><h2>{selectedSkill.title}</h2><p className="studio-detail-description">{selectedSkill.description}</p><div className="studio-detail-meta">{selectedSkill.author} · {selectedSkill.category} · {dateLabel(selectedSkill.updatedAt)}</div><div className="studio-skill-section"><h3><GitBranch size={16} />适用场景</h3><p>{selectedSkill.scenario}</p></div><div className="studio-skill-section"><h3><CheckCheck size={16} />执行步骤</h3><ol>{selectedSkill.steps.map((step, index) => <li key={index}>{step}</li>)}</ol></div><div className="studio-skill-section"><h3><ShieldCheck size={16} />边界与限制</h3><ul>{selectedSkill.boundaries.map((boundary, index) => <li key={index}>{boundary}</li>)}</ul></div><div className="studio-evidence"><span><FileText size={15} />原始案例证据</span><p>{selectedSkill.evidence}</p><small>来源：{selectedSkill.source}</small></div>{(selectedSkill.reviewer || selectedSkill.reviewNote) && <div className="studio-skill-section"><h3>审核记录</h3><p>审核人：{selectedSkill.reviewer ?? '未记录'}</p><p>审核意见：{selectedSkill.reviewNote ?? '未填写'}</p></div>}{manager && selectedSkill.status === 'candidate' && <div className="studio-review-box"><label>你的审核意见<textarea rows={3} maxLength={3000} value={reviewNote} onChange={event => setReviewNote(event.target.value)} placeholder="证据是否充分？哪些条件和边界需要保留？" /></label><div><button className="studio-btn studio-btn-secondary" disabled={busy || !reviewNote.trim()} onClick={() => reviewSkill('reject')}><RotateCcw size={15} />退回补充</button><button className="studio-btn studio-btn-primary" disabled={busy || !reviewNote.trim()} onClick={() => reviewSkill('publish')}><BusyIcon busy={busy}><Check size={15} /></BusyIcon>审核并发布</button></div><small>发布将同步加入团队生效知识。</small></div>}</> : <Empty icon={<Sparkles size={32} />} title="可复用的经验，需要完整的上下文" detail="选择 Skill，查看场景、步骤、证据与审核记录。" />}</article>
      </div>
    </>}
  </section>;
}

const NODE_TYPES: { type: NodeType; label: string; detail: string }[] = [
  { type: 'start', label: '开始', detail: '接收任务输入' }, { type: 'intent', label: '意图识别', detail: '识别任务与路由' }, { type: 'knowledge', label: '知识检索', detail: '检索生效知识' }, { type: 'agent', label: '领域专家', detail: '调用配置的专家' }, { type: 'review', label: '人工审核', detail: '在此暂停，等待确认' }, { type: 'output', label: '结果输出', detail: '返回本次执行结果' },
];
function NodeIcon({ type, size = 18 }: { type: NodeType; size?: number }) {
  if (type === 'start') return <Play size={size} />;
  if (type === 'intent') return <GitBranch size={size} />;
  if (type === 'knowledge') return <BookOpen size={size} />;
  if (type === 'agent') return <Bot size={size} />;
  if (type === 'review') return <ShieldCheck size={size} />;
  return <CheckCheck size={size} />;
}

export function StudioView(props: ViewProps) {
  return <WorkflowStudio key={props.state.role} {...props} />;
}

function WorkflowStudio({ state, mutate, notify }: ViewProps) {
  const manager = state.role === 'manager';
  const available = state.workflows.filter(item => manager || item.status === 'published');
  const { busy, error, setError, perform } = useMutation(mutate);
  const [selectedId, setSelectedId] = useState(() => available[0]?.id ?? '');
  const [draftState, setDraft] = useState<Workflow | null>(() => available[0] ? cloneWorkflow(available[0]) : null);
  const [dirty, setDirty] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState(() => available[0]?.nodes[0]?.id ?? '');
  const [nodeType, setNodeType] = useState<NodeType>('agent');
  const [edgeFrom, setEdgeFrom] = useState('');
  const [edgeTo, setEdgeTo] = useState('');
  const [query, setQuery] = useState('帮我准备一次客户拜访，明确需求、风险和下一步。');
  const [run, setRun] = useState<Run | null>(null);
  const [showTest, setShowTest] = useState(false);
  const drag = useRef<{ nodeId: string; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const current = state.workflows.find(item => item.id === selectedId);
  const draft = dirty ? draftState : current ?? draftState;
  const selectedNode = draft?.nodes.find(node => node.id === selectedNodeId);
  const edit = (update: (workflow: Workflow) => Workflow) => {
    if (!manager || busy) return;
    setDraft(previous => { const base = dirty ? previous : current ?? previous; return base ? update(base) : base; });
    setDirty(true);
  };
  const selectWorkflow = (workflow: Workflow) => {
    if (dirty) { setError('当前有未保存的修改。请先保存草稿，或撤销修改后再切换。'); return; }
    setSelectedId(workflow.id); setDraft(cloneWorkflow(workflow)); setSelectedNodeId(workflow.nodes[0]?.id ?? ''); setEdgeFrom(''); setEdgeTo(''); setRun(null); setError('');
  };
  const createWorkflow = () => {
    if (dirty) { setError('请先保存当前草稿，或撤销修改后再新建。'); return; }
    const workflow: Workflow = { id: '', name: '新的工作流', description: '从任务输入到专家协作，搭建一条可复用的业务路径。', status: 'draft', version: 0, updatedAt: new Date().toISOString(), nodes: [{ id: 'start', type: 'start', label: '开始', x: 48, y: 175 }, { id: 'output', type: 'output', label: '结果输出', x: 670, y: 175 }], edges: [] };
    setSelectedId('new'); setDraft(workflow); setDirty(true); setSelectedNodeId('start'); setRun(null); setError('');
  };
  const reset = () => { setDraft(current ? cloneWorkflow(current) : null); setSelectedNodeId(current?.nodes[0]?.id ?? ''); setDirty(false); setError(''); };
  const addNode = () => {
    if (!draft) return;
    const id = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const node: FlowNode = { id, type: nodeType, label: NODE_TYPES.find(item => item.type === nodeType)?.label ?? '节点', x: 60 + (draft.nodes.length % 3) * 250, y: 65 + Math.floor(draft.nodes.length / 3) * 145, ...(nodeType === 'agent' ? { agentId: 'strategy' as const } : {}) };
    edit(workflow => ({ ...workflow, nodes: [...workflow.nodes, node] })); setSelectedNodeId(id);
  };
  const updateNode = (changes: Partial<FlowNode>) => edit(workflow => ({ ...workflow, nodes: workflow.nodes.map(node => node.id === selectedNodeId ? { ...node, ...changes } : node) }));
  const connect = () => {
    if (!draft || !edgeFrom || !edgeTo) { setError('请选择起点和终点节点。'); return; }
    if (edgeFrom === edgeTo) { setError('节点不能连接自身。'); return; }
    if (draft.edges.some(edge => edge.from === edgeFrom && edge.to === edgeTo)) { setError('这条连线已经存在。'); return; }
    edit(workflow => ({ ...workflow, edges: [...workflow.edges, { from: edgeFrom, to: edgeTo }] })); setError('');
  };
  const save = async () => {
    if (!draft || !draft.name.trim()) { setError('请填写工作流名称。'); return; }
    const result = await perform('workflow_save', { workflow: { ...draft, name: draft.name.trim() } });
    if (result) {
      const saved = result.state.workflows.find(item => item.id === draft.id) ?? result.state.workflows.find(item => !state.workflows.some(old => old.id === item.id));
      if (saved) { setDraft(cloneWorkflow(saved)); setSelectedId(saved.id); setDirty(false); }
      notify('工作流草稿已保存。测试将按已保存的节点和连线执行。');
    }
  };
  const publish = async () => {
    if (!current || dirty) return;
    const result = await perform('workflow_publish', { workflowId: current.id, version: current.version });
    if (result) { const published = result.state.workflows.find(item => item.id === current.id); if (published) setDraft(cloneWorkflow(published)); notify('工作流已发布，销售视角可使用。'); }
  };
  const test = async (event: FormEvent) => {
    event.preventDefault();
    if (!current || dirty || !query.trim()) return;
    const result = await perform('workflow_run', { workflowId: current.id, query: query.trim() });
    if (result?.run) { setRun(result.run); notify(result.message || '工作流运行记录已保存。'); }
  };
  const canvasWidth = Math.max(920, ...(draft?.nodes.map(node => node.x + 240) ?? []));
  const canvasHeight = Math.max(510, ...(draft?.nodes.map(node => node.y + 160) ?? []));
  return <section className="studio-view studio-builder-view">
    <PageHeading eyebrow="BUILD WITH INTENTION" title="把协作方式，搭建成工作流" description={manager ? '配置节点、连接路径、用真实执行结果验证，再发布给团队。' : '选择已发布的工作流，把成熟的协作路径用于今天的任务。'}>{manager && <button className="studio-btn studio-btn-secondary" onClick={createWorkflow} disabled={busy}><Plus size={16} />新建工作流</button>}</PageHeading>
    {error && <Notice error>{error}</Notice>}
    <div className="studio-flow-picker" aria-label="选择工作流">{available.map(workflow => <button key={workflow.id} className={`studio-flow-choice${selectedId === workflow.id ? ' studio-flow-choice-active' : ''}`} onClick={() => selectWorkflow(workflow)} disabled={busy}><GitBranch size={20} /><div><strong>{workflow.name}</strong><span>{workflow.status === 'published' ? '已发布' : '草稿'} · {workflow.nodes.length} 个节点 · v{workflow.version}</span></div><ChevronRight size={16} /></button>)}{!available.length && !draft && <Empty icon={<GitBranch size={30} />} title={manager ? '搭建第一条业务路径' : '暂无可用工作流'} detail={manager ? '新建一个工作流，从开始节点连接到结果输出。' : '管理者发布工作流后，可在这里发起任务。'} />}</div>
    {draft && <div className="studio-builder"><div className="studio-builder-top"><div><div className="studio-row"><GitBranch size={18} /><h2>{draft.name}</h2><span className="studio-tag">{dirty ? '未保存' : current?.status === 'published' ? '已发布' : '草稿'}</span></div><p>{draft.description}</p></div><div className="studio-row">{manager && <><button className="studio-btn studio-btn-ghost" onClick={reset} disabled={busy || !dirty}><RotateCcw size={15} />撤销修改</button><button className="studio-btn studio-btn-secondary" onClick={save} disabled={busy || !dirty}><BusyIcon busy={busy}><Save size={15} /></BusyIcon>保存草稿</button></>}<button className="studio-btn studio-btn-secondary" onClick={() => setShowTest(!showTest)} disabled={busy}><Play size={15} />{showTest ? '收起测试' : manager ? '测试运行' : '运行工作流'}</button>{manager && <button className="studio-btn studio-btn-primary" onClick={publish} disabled={busy || dirty || !current || current.status === 'published'}><Check size={15} />发布</button>}</div></div>
      <div className="studio-canvas-toolbar"><div className="studio-row">{manager ? <><label><span className="studio-sr-only">新增节点类型</span><select value={nodeType} onChange={event => setNodeType(event.target.value as NodeType)} disabled={busy}>{NODE_TYPES.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}</select></label><button className="studio-btn studio-btn-ghost" onClick={addNode} disabled={busy}><Plus size={15} />添加节点</button><span className="studio-toolbar-divider" /><button className="studio-btn studio-btn-ghost" disabled={busy || draft.nodes.length < 2} onClick={() => { const nodes = [...draft.nodes].sort((a, b) => a.x - b.x || a.y - b.y); edit(workflow => ({ ...workflow, edges: nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id })) })); setError(''); }}><Link2 size={15} />从左至右连接</button></> : <span>已发布工作流 · 只读配置</span>}</div><span><Grip size={14} />{manager ? '拖动节点 · 方向键移动 24px' : '点击节点查看配置'}</span></div>
      <div className="studio-canvas-layout"><div className="studio-canvas-scroll"><div className="studio-canvas" style={{ width: canvasWidth, height: canvasHeight }} aria-label="工作流画布"><svg className="studio-edges" width={canvasWidth} height={canvasHeight} aria-hidden="true"><defs><marker id="studio-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="currentColor" /></marker></defs>{draft.edges.map((edge, index) => { const from = draft.nodes.find(node => node.id === edge.from); const to = draft.nodes.find(node => node.id === edge.to); if (!from || !to) return null; const x1 = from.x + 206, y1 = from.y + 46, x2 = to.x, y2 = to.y + 46; const curve = Math.max(55, Math.abs(x2 - x1) / 2); return <path key={`${edge.from}-${edge.to}-${index}`} d={`M${x1},${y1} C${x1 + curve},${y1} ${x2 - curve},${y2} ${x2 - 6},${y2}`} markerEnd="url(#studio-arrow)" />; })}</svg>{draft.nodes.map(node => <button key={node.id} type="button" className={`studio-flow-node studio-node-${node.type}${selectedNodeId === node.id ? ' studio-node-selected' : ''}`} style={{ left: node.x, top: node.y }} aria-pressed={selectedNodeId === node.id} aria-label={`${node.label}，${NODE_TYPES.find(item => item.type === node.type)?.label}节点${manager ? '，方向键可移动' : ''}`} onClick={() => setSelectedNodeId(node.id)} onPointerDown={event => { setSelectedNodeId(node.id); if (!manager || busy || event.button !== 0) return; drag.current = { nodeId: node.id, clientX: event.clientX, clientY: event.clientY, x: node.x, y: node.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { const moving = drag.current; if (!moving || moving.nodeId !== node.id) return; const x = Math.max(12, Math.round(moving.x + event.clientX - moving.clientX)), y = Math.max(12, Math.round(moving.y + event.clientY - moving.clientY)); edit(workflow => ({ ...workflow, nodes: workflow.nodes.map(item => item.id === node.id ? { ...item, x, y } : item) })); }} onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }} onKeyDown={event => { const movement: Record<string, [number, number]> = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }; if (manager && movement[event.key]) { event.preventDefault(); const [dx, dy] = movement[event.key]; edit(workflow => ({ ...workflow, nodes: workflow.nodes.map(item => item.id === node.id ? { ...item, x: Math.max(12, item.x + dx), y: Math.max(12, item.y + dy) } : item) })); } }}><span className="studio-node-input" /><div><span className="studio-node-icon"><NodeIcon type={node.type} /></span><strong>{node.label}</strong>{manager && <Grip size={14} className="studio-node-grip" />}</div><p>{node.type === 'agent' && node.agentId ? agentName(node.agentId) : NODE_TYPES.find(item => item.type === node.type)?.detail}</p><span className="studio-node-output" /></button>)}</div></div>
        <aside className="studio-node-config"><div className="studio-config-heading"><h3>{selectedNode ? '节点配置' : '工作流配置'}</h3><span>{selectedNode ? NODE_TYPES.find(item => item.type === selectedNode.type)?.label : '基础信息'}</span></div><div className="studio-config-content"><label>工作流名称<input value={draft.name} readOnly={!manager} maxLength={100} onChange={event => edit(workflow => ({ ...workflow, name: event.target.value }))} /></label><label>工作流说明<textarea rows={2} maxLength={1000} readOnly={!manager} value={draft.description} onChange={event => edit(workflow => ({ ...workflow, description: event.target.value }))} /></label>{selectedNode ? <><div className="studio-config-divider" /><label>节点名称<input value={selectedNode.label} maxLength={80} readOnly={!manager} onChange={event => updateNode({ label: event.target.value })} /></label>{selectedNode.type === 'agent' && <label>调用专家<select value={selectedNode.agentId ?? 'strategy'} disabled={!manager || busy} onChange={event => updateNode({ agentId: event.target.value as FlowNode['agentId'] })}>{AGENTS.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>}<label>执行指令<textarea rows={4} maxLength={3000} readOnly={!manager} value={selectedNode.instruction ?? ''} onChange={event => updateNode({ instruction: event.target.value })} placeholder="补充本节点的目标、处理要求与边界…" /></label>{manager && <><div className="studio-form-row studio-node-coordinates"><label>X 坐标<input type="number" min={12} max={6000} value={selectedNode.x} onChange={event => updateNode({ x: Math.max(12, Math.min(6000, Number(event.target.value))) })} /></label><label>Y 坐标<input type="number" min={12} max={4000} value={selectedNode.y} onChange={event => updateNode({ y: Math.max(12, Math.min(4000, Number(event.target.value))) })} /></label></div><button className="studio-btn studio-btn-danger" disabled={busy} onClick={() => { edit(workflow => ({ ...workflow, nodes: workflow.nodes.filter(node => node.id !== selectedNode.id), edges: workflow.edges.filter(edge => edge.from !== selectedNode.id && edge.to !== selectedNode.id) })); setSelectedNodeId(''); }}><Trash2 size={14} />删除此节点</button></>}{selectedNode.type === 'review' && <Notice>执行到此节点会暂停并提示人工审核，不会自动批准或发布。</Notice>}</> : <p className="studio-muted">点击画布节点查看配置。使用 Tab 可依次选择节点。</p>}</div></aside>
      </div>
      {manager && <div className="studio-connections"><div className="studio-connect-form"><span><Link2 size={16} />连接节点</span><label><span className="studio-sr-only">连线起点</span><select value={edgeFrom} onChange={event => setEdgeFrom(event.target.value)} disabled={busy}><option value="">选择起点</option>{draft.nodes.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label><ArrowRight size={15} /><label><span className="studio-sr-only">连线终点</span><select value={edgeTo} onChange={event => setEdgeTo(event.target.value)} disabled={busy}><option value="">选择终点</option>{draft.nodes.map(node => <option key={node.id} value={node.id}>{node.label}</option>)}</select></label><button className="studio-btn studio-btn-secondary" onClick={connect} disabled={busy || !edgeFrom || !edgeTo}><Plus size={14} />添加连线</button></div><div className="studio-edge-list">{draft.edges.map((edge, index) => <span key={`${edge.from}-${edge.to}-${index}`}>{draft.nodes.find(node => node.id === edge.from)?.label}<ArrowRight size={12} />{draft.nodes.find(node => node.id === edge.to)?.label}<button onClick={() => edit(workflow => ({ ...workflow, edges: workflow.edges.filter((_, edgeIndex) => edgeIndex !== index) }))} aria-label={`删除从${draft.nodes.find(node => node.id === edge.from)?.label}到${draft.nodes.find(node => node.id === edge.to)?.label}的连线`} disabled={busy}><X size={12} /></button></span>)}{!draft.edges.length && <small>暂无连线。可使用上方选择框连接节点，或从左至右自动连接。</small>}</div></div>}
      <footer className="studio-canvas-footer"><span><Square size={13} />{draft.nodes.length} 个节点 · {draft.edges.length} 条连线</span><span>{dirty ? '请保存草稿后测试或发布' : `版本 ${draft.version} · 已保存配置`}</span></footer>
    </div>}
    {draft && showTest && <section className="studio-test-panel"><div className="studio-panel-heading"><div><h2><Play size={17} />{manager ? '测试这条业务路径' : '发起工作流任务'}</h2><p>运行按已保存图结构执行，结果和每一步处理均会持久保存。</p></div>{state.model.connected ? <ModeTag mode="live" configured /> : <ModeTag mode="demo" />}</div>{dirty && <Notice>当前有未保存修改，请先保存草稿，再测试这次配置。</Notice>}<form onSubmit={test} className="studio-test-form"><label className="studio-sr-only" htmlFor="workflow-query">工作流任务输入</label><textarea id="workflow-query" rows={3} value={query} maxLength={5000} onChange={event => setQuery(event.target.value)} placeholder="输入这次需要工作流完成的业务任务…" /><button className="studio-btn studio-btn-primary" disabled={busy || dirty || !current || !query.trim()}><BusyIcon busy={busy}><Play size={15} /></BusyIcon>{busy ? '执行中…' : '开始运行'}</button></form>{run && <RunDetail run={run} compact />}</section>}
  </section>;
}

function RunDetail({ run, compact = false }: { run: Run; compact?: boolean }) {
  return <article className={`studio-run-detail${compact ? ' studio-run-compact' : ''}`}><div className="studio-detail-kicker"><ModeTag mode={run.mode} /><span><Clock3 size={13} />{durationLabel(run.duration)} · {dateLabel(run.createdAt)}</span></div><h2>{run.query}</h2><div className="studio-run-experts">{run.agentIds.map(id => <span key={id}><Bot size={13} />{agentName(id)}</span>)}{run.workflowId && <span><GitBranch size={13} />工作流执行</span>}</div><div className="studio-run-answer"><span className="studio-section-label">任务结果</span><div>{run.answer}</div></div><div className="studio-run-section"><h3><GitBranch size={16} />执行轨迹<span>{run.steps.length} 步</span></h3><ol className="studio-trace">{run.steps.map((step, index) => <li key={step.id} className={`studio-trace-${step.status}`}><span className="studio-trace-marker">{step.status === 'success' ? <Check size={12} /> : step.status === 'warning' ? <Info size={12} /> : <X size={12} />}</span><div><div className="studio-trace-heading"><strong>{index + 1}. {step.title}</strong><small>{durationLabel(step.duration)}</small></div>{step.agent && <span className="studio-trace-agent">{agentName(step.agent)}</span>}<p>{step.detail}</p></div></li>)}</ol></div><div className="studio-run-section"><h3><BookOpen size={16} />引用依据<span>{run.citations.length} 条</span></h3>{run.citations.length ? run.citations.map(citation => <div className="studio-citation" key={citation.id}><strong><FileText size={15} />{citation.title}</strong><p>{citation.excerpt}</p><small>引用编号：{citation.id}</small></div>) : <p className="studio-muted">本次运行没有引用知识条目。请结合执行轨迹核对结论依据。</p>}</div><div className="studio-run-id">运行编号 {run.id}</div></article>;
}

export function RunsView({ state, mutate, notify }: ViewProps) {
  const { busy, error, perform } = useMutation(mutate);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('all');
  const [selectedId, setSelectedId] = useState(state.runs[0]?.id ?? '');
  const query = search.trim().toLowerCase();
  const runs = [...state.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter(run => (mode === 'all' || mode === run.mode) && `${run.query} ${run.answer} ${run.agentIds.map(agentName).join(' ')} ${run.id}`.toLowerCase().includes(query));
  const selected = runs.find(run => run.id === selectedId) ?? runs[0];
  const existingCandidate = selected && state.skills.find(skill => skill.source.includes(selected.id));
  const extractCandidate = async () => {
    if (!selected || busy) return;
    const run = selected;
    const result = await perform('skill_candidate', {
      title: `${run.query.slice(0, 36)} · 方法草稿`,
      description: '依据本次运行的任务、执行轨迹与引用整理的方法草稿。需要管理者核对原始事实、适用条件和授权边界。',
      scenario: `适用于类似任务：“${run.query.slice(0, 1800)}”。复用前核实客户、业务阶段、关键事实和现行政策。`,
      steps: run.steps.length ? run.steps.slice(0, 12).map(step => `复用“${step.title}”：${step.detail}`.slice(0, 1900)) : ['澄清任务目标与待核实事实', '核对生效知识及业务授权边界', '形成建议并与实际反馈逐项验证'],
      boundaries: ['当前工作空间使用示例数据；示例结果不构成真实客户反馈、成交或转化证据。', '本次运行输出属于方法草稿，需管理者核对原始依据后人工审核。', '不得承诺未经审批的优惠、交付或商务条件；复用时重新核对生效知识。'],
      evidence: `证据性质：本工作空间为示例数据；以下运行结果不是成交或转化证据。仅保留任务和执行输出供人工审核。\n运行编号：${run.id}\n运行模式：${run.mode === 'demo' ? '规则演示' : '模型生成'}\n\n原始任务：${run.query.slice(0, 1100)}\n\n原始结果片段：${run.answer.slice(0, 3200)}\n\n引用来源：${run.citations.map(item => item.title).join('；').slice(0, 250)}`.slice(0, 5000),
      source: `运行记录 ${run.id} · ${dateLabel(run.createdAt)} · ${run.mode === 'demo' ? '规则演示' : '模型生成'}`,
    });
    if (result) notify('已提炼为候选 Skill，待管理者本人核对证据与边界后审核。');
  };
  return <section className="studio-view"><PageHeading eyebrow="EVERY STEP, IN CONTEXT" title="每次协作，都有迹可循" description="回看任务结果、调用专家与引用来源，了解建议从何而来。"><span className="studio-example"><History size={15} />{state.runs.length} 次已保存运行</span></PageHeading>{error && <Notice error>{error}</Notice>}<div className="studio-filterbar"><label className="studio-search"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索任务、结果、专家或运行编号" aria-label="搜索运行记录" />{search && <button className="studio-icon-button" onClick={() => setSearch('')} aria-label="清空搜索"><X size={15} /></button>}</label><label className="studio-category"><span className="studio-sr-only">筛选运行模式</span><select value={mode} onChange={event => setMode(event.target.value)}><option value="all">全部模式</option><option value="demo">规则演示</option><option value="live">模型生成</option></select></label><span className="studio-result-count">{runs.length} 条记录</span></div><div className="studio-runs-layout"><div className="studio-run-list">{runs.length ? runs.map(run => <button key={run.id} className={`studio-run-item${selected?.id === run.id ? ' studio-run-item-active' : ''}`} onClick={() => setSelectedId(run.id)}><div><span className="studio-run-list-icon">{run.workflowId ? <GitBranch size={17} /> : <MessageSquare size={17} />}</span><span>{dateLabel(run.createdAt)}</span><span className="studio-run-mode">{run.mode === 'demo' ? '演示' : '模型'}</span></div><h3>{run.query}</h3><p>{run.agentIds.map(agentName).join(' · ') || '工作流执行'}</p><small>{run.steps.length} 个执行步骤 · {durationLabel(run.duration)}<ChevronRight size={15} /></small></button>) : <Empty icon={<History size={30} />} title={query ? '没有找到匹配的运行' : '协作记录从下一次任务开始'} detail={query ? '换一个关键词，或切换运行模式。' : '发起专家任务或运行工作流后，完整过程会出现在这里。'} />}</div><div className="studio-run-content">{selected ? <><div className="studio-run-extract"><p><Sparkles size={15} />将本次方法整理为草稿，由管理者核实后发布。</p><button className="studio-btn studio-btn-secondary" onClick={extractCandidate} disabled={busy || !!existingCandidate}><BusyIcon busy={busy}><Plus size={15} /></BusyIcon>{existingCandidate ? '已提炼经验' : '提炼为候选 Skill'}</button></div><RunDetail run={selected} /></> : <Empty icon={<GitBranch size={32} />} title="看见每一步的依据" detail="选择一条运行记录，查看完整结果与执行轨迹。" />}</div></div></section>;
}

export function SettingsView({ state }: ViewProps) {
  return <section className="studio-view studio-settings-view"><PageHeading eyebrow="YOUR WORKSPACE" title="关于这个工作空间" description="了解当前体验视角、数据范围与模型接口配置。" /><section className="studio-settings-card"><div className="studio-settings-card-title"><span className="studio-icon-clay"><ShieldCheck size={23} /></span><div><h2>当前体验身份</h2><p>私有工作空间内的角色体验</p></div><span className="studio-tag">{state.role === 'manager' ? '销售管理者' : '销售人员'}</span></div><div className="studio-identity"><div className="studio-profile-avatar">{state.viewer.name.slice(0, 1)}</div><div><strong>{state.viewer.name}</strong><span>{state.viewer.team}</span></div></div><div className="studio-role-grid"><div className={state.role === 'sales' ? 'studio-role-active' : ''}><h3><MessageSquare size={17} />销售人员</h3><p>管理自己名下的客户和商机，获得五位专家协助，开展带练并提交经验。</p></div><div className={state.role === 'manager' ? 'studio-role-active' : ''}><h3><ShieldCheck size={17} />销售管理者</h3><p>查看体验团队商机，审核候选 Skill，导入知识并搭建、测试和发布工作流。</p></div></div><Notice>角色切换仅用于体验业务权限；当前未接入企业 SSO、真实组织或 CRM 账户。</Notice></section><section className="studio-settings-card"><div className="studio-settings-card-title"><span className="studio-icon-clay"><Bot size={23} /></span><div><h2>模型与执行方式</h2><p>配置状态由服务端决定</p></div><ModeTag mode={state.model.connected ? 'live' : 'demo'} configured /></div><div className="studio-setting-line"><span>当前模型</span><strong>{state.model.connected ? state.model.name : '未配置外部模型'}</strong></div><div className="studio-setting-line"><span>生成方式</span><strong>{state.model.connected ? '服务端尝试调用已配置接口；实际模式见每次运行' : '规则与模板生成，明确标记为演示'}</strong></div><p className="studio-setting-description">{state.model.connected ? '模型接口环境变量已配置；实际连通性以运行详情中记录的返回结果和错误为准。' : '演示模式可以体验意图路由、知识引用、商机规则健康度、训练反馈和工作流执行。模型接口尚未配置，页面不会模拟实时模型回执。'}</p><details className="studio-deployment-details"><summary><Code2 size={16} />部署与模型接入说明<ChevronRight size={15} /></summary><p>由部署维护者在服务端环境中配置以下变量。密钥仅供服务端使用，业务页面不接收或展示密钥。</p><dl><div><dt>MODEL_API_KEY</dt><dd>模型服务密钥</dd></div><div><dt>MODEL_BASE_URL</dt><dd>HTTPS 的 OpenAI 兼容 API 地址，包含所需路径，如 /v1</dd></div><div><dt>MODEL_NAME</dt><dd>服务提供方支持的模型名称</dd></div></dl><p>配置后重新部署，再从工作台发起任务并核对运行记录中的模型模式和执行轨迹。</p></details></section><section className="studio-settings-card"><div className="studio-settings-card-title"><span className="studio-icon-clay"><Database size={23} /></span><div><h2>示例数据与存储</h2><p>用清晰的数据边界，理解产品能力</p></div><span className="studio-tag">全部为示例数据</span></div><div className="studio-setting-line"><span>当前数据版本</span><strong>Revision {state.revision}</strong></div><div className="studio-setting-line"><span>持久化范围</span><strong>商机修改、知识、Skill、工作流、带练与运行记录</strong></div><p className="studio-setting-description">初始化客户、商机和案例均为示例。商机分值表示基于规则的健康度，不能作为已校准的成交概率。业务记录保存在当前私有体验空间的服务端；未连接企业真实数据。</p></section></section>;
}
