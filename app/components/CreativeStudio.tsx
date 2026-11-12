'use client';

import { AppWindow, Archive, ArrowLeft, ArrowUp, ArrowUpRight, BookOpen, FilePenLine, FolderOpen, Image, LayoutTemplate, PanelsTopLeft, Plus, RotateCcw, Save, Smartphone, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyStudioCopy, STUDIO_KINDS, STUDIO_KIND_LABELS } from '../lib/creative-studio-types';
import type { StudioBoard, StudioDocument, StudioGenerateMode, StudioGenerateResult, StudioKind, StudioRecord,
  StudioImage, StudioSelection, StudioSummary, StudioTemplate, StudioVersion } from '../lib/creative-studio-types';
import { StudioRequestError, studioCoverRequestId, studioImageOptions, studioRequest } from '../lib/creative-studio-client';
import type { MaterialKind, PublicMaterialTask } from '../lib/marketing-material-types';
import StudioCanvas, { BoardPreview } from './StudioCanvas';
import StudioAssets from './StudioAssets';
import StudioContent from './StudioContent';
import StudioMarket from './StudioMarket';
import StudioVersions from './StudioVersions';
import { BUILTIN_STUDIO_TEMPLATES, createStarterBoards } from '../lib/creative-studio-templates';
import './creative-studio.css';

const titleByKind = { poster: '营销创作', web: '网页设计', app: 'App 设计', mini: '小程序设计' };
const iconByKind = { poster: Image, web: AppWindow, app: Smartphone, mini: PanelsTopLeft };
const panelLabels = { content: '成稿', canvas: '设计画布', versions: '版本比较' };
type Panel = keyof typeof panelLabels;
type Surface = 'home' | 'project' | 'market' | 'assets';
type ProjectList = { projects: StudioSummary[]; modelAvailable: boolean };
type ProjectDetail = { project: StudioRecord; versions: StudioVersion[] };
type MediaList = { tasks: PublicMaterialTask[]; availability: Record<MaterialKind, boolean> };
const imageStates = {
  submitting: '正在提交', submission_unknown: '提交结果待核对', queued: '排队中', processing: '生成中',
  saving: '保存中', completed: '已保存到素材库', failed: '生成失败', expired: '已过期',
};
const terminalImages = ['completed', 'failed', 'expired'];
const stamp = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
const MAX_BOARDS = 8;
const previews = STUDIO_KINDS.map(kind => ({
  kind, board: BUILTIN_STUDIO_TEMPLATES.find(template => template.kind === kind)?.boards[0],
}));
const firstBoard = (document: StudioDocument): StudioSelection =>
  document.boards[0] ? { boardId: document.boards[0].id } : null;
const projectQuery = (id: string) => `?id=${encodeURIComponent(id)}`;
const displayError = (error: unknown) => error instanceof Error ? error.message : '操作暂时未完成。';

function newProject(kind: StudioKind, template?: StudioTemplate): StudioRecord {
  return {
    id: crypto.randomUUID(), version: 0, updatedAt: '',
    document: {
      title: template?.title ?? titleByKind[kind], kind, brief: '', audience: '',
      channel: '通用', style: '自然口语', copy: emptyStudioCopy(),
      boards: template ? structuredClone(template.boards) : createStarterBoards(kind),
    },
  };
}

function artworkFromCopy(document: StudioDocument): StudioBoard {
  const format = document.boards[0] ?? createStarterBoards(document.kind)[0];
  const id = crypto.randomUUID();
  const font = Math.round(format.width * 0.065);
  const common = { kind: 'text' as const, assetUrl: '', fill: 'transparent', radius: 0, x: 9, width: 82, align: 'left' as const };
  return {
    id, name: '稿件排版', width: format.width, height: format.height, background: '#F2F0E9',
    layers: [
      { ...common, id: crypto.randomUUID(), name: '标题', text: document.copy.title,
        y: 13, height: 34, color: '#222927', fontSize: font, weight: 'bold' },
      { ...common, id: crypto.randomUUID(), name: '文案', text: document.copy.caption.slice(0, 500),
        y: 52, height: 40, color: '#3F514A', fontSize: Math.round(font * 0.49), weight: 'normal' },
    ],
  };
}

interface Props {
  notify: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}

export default function CreativeStudio({ notify, onDirtyChange, onBusyChange }: Props) {
  const [projects, setProjects] = useState<StudioSummary[]>([]);
  const [record, setRecord] = useState<StudioRecord>();
  const [versions, setVersions] = useState<StudioVersion[]>([]);
  const [baseline, setBaseline] = useState('');
  const [panel, setPanel] = useState<Panel>('content');
  const [surface, setSurface] = useState<Surface>('home');
  const [idea, setIdea] = useState('');
  const [templates, setTemplates] = useState<StudioTemplate[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [templateTitle, setTemplateTitle] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [selection, setSelection] = useState<StudioSelection>(null);
  const [revisionNote, setRevisionNote] = useState('');
  const [media, setMedia] = useState<MediaList>();
  const [mediaLoading, setMediaLoading] = useState(true);
  const [assetError, setAssetError] = useState('');
  const [modelAvailable, setModelAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [indexError, setIndexError] = useState('');
  const [pending, setPending] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [search, setSearch] = useState('');
  const [projectListOpen, setProjectListOpen] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const document = record?.document;
  const dirty = Boolean(record && (record.version === 0 || JSON.stringify(document) !== baseline));
  const market = surface === 'market';
  const inProject = surface === 'project' && Boolean(record);
  const busy = Boolean(pending || scheduleBusy);
  const images = studioImageOptions(media?.tasks ?? []);
  const imageTask = record && media?.tasks.find(task => task.requestId.startsWith(`studio-cover-${record.id}-`));
  const filteredProjects = projects.filter(project => `${project.title} ${STUDIO_KIND_LABELS[project.kind]}`.toLowerCase().includes(search.trim().toLowerCase()));

  const loadIndex = useCallback(async () => {
    setLoading(true);
    setIndexError('');
    try {
      const data = await studioRequest<ProjectList>();
      if (mounted.current) { setProjects(data.projects); setModelAvailable(data.modelAvailable); }
    } catch (error) {
      if (mounted.current) setIndexError(displayError(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  const loadMedia = useCallback(async () => {
    setMediaLoading(true);
    try {
      const data = await studioRequest<MediaList>('', undefined, '/api/marketing-materials');
      if (mounted.current) { setMedia(data); setAssetError(''); }
    } catch (error) {
      if (mounted.current) setAssetError(displayError(error));
    } finally {
      if (mounted.current) setMediaLoading(false);
    }
  }, []);
  const loadMarket = useCallback(async () => {
    setMarketLoading(true);
    setMarketError('');
    try {
      const data = await studioRequest<{ templates: StudioTemplate[] }>('?market=1');
      if (mounted.current) setTemplates(data.templates);
    } catch (error) {
      if (mounted.current) setMarketError(displayError(error));
    } finally {
      if (mounted.current) setMarketLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => { void loadIndex(); void loadMedia(); }, 0);
    return () => { mounted.current = false; clearTimeout(timer); };
  }, [loadIndex, loadMedia]);
  useEffect(() => { onDirtyChange?.(dirty || Boolean(idea.trim())); }, [dirty, idea, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, [onDirtyChange, onBusyChange]);

  async function run(label: string, operation: () => Promise<void>, recoverProject = false) {
    if (inFlight.current || scheduleBusy) return;
    inFlight.current = true;
    setPending(label);
    setError('');
    setConflict(false);
    try { await operation(); }
    catch (error) {
      if (!mounted.current) return;
      setError(displayError(error));
      setConflict(recoverProject && error instanceof StudioRequestError && error.status === 409);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending('');
    }
  }
  function canLeave() {
    return !busy && (!dirty || window.confirm('当前草稿尚未保存。放弃草稿并切换项目？'));
  }
  function selectProject(next: StudioRecord, history: StudioVersion[], destination: Panel) {
    setRecord(next);
    setBaseline(JSON.stringify(next.document));
    setVersions(history);
    setSelection(firstBoard(next.document));
    setRevisionNote('');
    setError('');
    setConflict(false);
    setSurface('project');
    setPublishing(false);
    setProjectListOpen(false);
    setPanel(destination);
  }
  function start(kind: StudioKind, template?: StudioTemplate, brief = '') {
    if (!canLeave()) return;
    const next = newProject(kind, template);
    if (brief) {
      next.document.brief = brief;
      next.document.title = brief.split(/[\n。！？]/)[0].trim().slice(0, 55) || next.document.title;
      setIdea('');
    }
    selectProject(next, [], template || kind !== 'poster' ? 'canvas' : 'content');
  }
  function openProject(id: string, reload = false) {
    if (!reload && record?.id === id) {
      setSurface('project'); setPublishing(false); setProjectListOpen(false);
      return;
    }
    if (!canLeave()) return;
    void run('读取项目…', async () => {
      const data = await studioRequest<ProjectDetail>(projectQuery(id));
      if (mounted.current) selectProject(data.project, data.versions, 'content');
    });
  }
  function update(next: StudioDocument) {
    setRecord(current => current && { ...current, document: next });
  }
  function save(event: React.FormEvent) {
    event.preventDefault();
    if (!record || !document?.title.trim() || !dirty) return;
    void run('保存项目…', async () => {
      const { project } = await studioRequest<{ project: StudioRecord }>('', {
        action: 'save', id: record.id, version: record.version, document,
      });
      if (!mounted.current) return;
      setRecord(project);
      setBaseline(JSON.stringify(project.document));
      setVersions(current => [{ version: project.version, updatedAt: project.updatedAt }, ...current.filter(item => item.version !== project.version)]);
      setProjects(current => [{ id: project.id, title: project.document.title, kind: project.document.kind,
        version: project.version, updatedAt: project.updatedAt }, ...current.filter(item => item.id !== project.id)]);
      notify(`已保存版本 ${project.version}`);
    }, true);
  }
  function archive() {
    if (!record || !window.confirm(`归档「${record.document.title}」？此项目将从创作列表移除。`)) return;
    void run('归档项目…', async () => {
      await studioRequest('', { action: 'archive', id: record.id, version: record.version });
      if (!mounted.current) return;
      setProjects(current => current.filter(item => item.id !== record.id));
      setRecord(undefined);
      setSurface('home');
      notify('项目已归档');
    });
  }
  function generate(mode: StudioGenerateMode, instruction?: string) {
    if (!document || !modelAvailable || mode === 'revise' && !selection) return;
    const label = mode === 'copy' ? '正在起草营销稿件…' : mode === 'design' ? '正在制作设计方向…' : '正在修改选中内容…';
    void run(label, async () => {
      const result = await studioRequest<StudioGenerateResult>('', {
        action: 'generate', mode, document, instruction, ...(mode === 'revise' ? { selection } : {}),
      });
      if (!mounted.current) return;
      if (mode === 'copy' && result.copy) { update({ ...document, copy: result.copy }); notify('稿件已生成，可继续编辑'); return; }
      if (mode === 'design' && result.boards?.length) {
        const boards = result.boards.slice(0, MAX_BOARDS - document.boards.length);
        if (!boards.length) throw new Error('画板已达到上限。移除一个画板后再生成。');
        update({ ...document, boards: [...document.boards, ...boards] });
        setSelection({ boardId: boards[0].id });
        notify(`已生成 ${boards.length} 个设计方向`);
        return;
      }
      if (mode === 'revise' && selection && result.boards?.length) {
        const revised = { ...result.boards[0], id: selection.boardId };
        update({ ...document, boards: document.boards.map(board => board.id === selection.boardId ? revised : board) });
        setSelection({ boardId: revised.id, ...(revised.layers.some(layer => layer.id === selection.layerId) ? { layerId: selection.layerId } : {}) });
        setRevisionNote('');
        notify('选中画板已更新');
        return;
      }
      throw new Error('模型未返回可用内容，请调整资料后重试。');
    });
  }
  function fromCopy() {
    if (!document || document.boards.length >= MAX_BOARDS) return;
    const board = artworkFromCopy(document);
    update({ ...document, boards: [...document.boards, board] });
    setSelection({ boardId: board.id });
    setPanel('canvas');
  }
  function image(action: 'generate' | 'refresh') {
    if (!record?.version || !document || !media?.availability.image || mediaLoading) return;
    const prompt = document.copy.coverPrompt.trim().slice(0, 1800);
    if (action === 'generate' && !prompt || action === 'refresh' && !imageTask) return;
    const input = { kind: 'image', prompt, size: document.kind === 'web' ? '3:2' : '2:3', n: 1 };
    void run(action === 'generate' ? '提交封面图片任务…' : '查询封面进度…', async () => {
      let body: object;
      if (action === 'generate') {
        const requestPrefix = await studioCoverRequestId(record.id, input);
        const latest = media.tasks.find(task => task.requestId === requestPrefix || task.requestId.startsWith(requestPrefix + '-'));
        if (latest && !terminalImages.includes(latest.status)) return;
        const requestId = latest ? await studioCoverRequestId(record.id, input, latest.id) : requestPrefix;
        body = { action, requestId, input };
      } else {
        body = { action, taskId: imageTask!.id, version: imageTask!.version };
      }
      try {
        const { task } = await studioRequest<{ task: PublicMaterialTask }>('', body, '/api/marketing-materials');
        if (!mounted.current) return;
        setMedia(current => current && { ...current, tasks: [task, ...current.tasks.filter(item => item.id !== task.id)] });
        if (task.status === 'completed') notify('封面已进入素材库，可在画布的图片图层中选择。');
      } catch (error) {
        await loadMedia();
        if (action === 'refresh' && error instanceof StudioRequestError && error.status === 409) return;
        throw error;
      }
    });
  }
  function restore(snapshot: StudioDocument) {
    if (dirty && !window.confirm('用选定版本替换当前未保存草稿？')) return;
    update(structuredClone(snapshot));
    setSelection(firstBoard(snapshot));
    setPanel('canvas');
    notify('旧版已载入草稿。保存后会创建新版本。');
  }
  function publish(event: React.FormEvent) {
    event.preventDefault();
    if (!record || !record.version || dirty || !templateTitle.trim() || !templateDescription.trim()) return;
    void run('发布模板…', async () => {
      const { template } = await studioRequest<{ template: StudioTemplate }>('', {
        action: 'publishTemplate', id: record.id, version: record.version, title: templateTitle, description: templateDescription,
      });
      if (!mounted.current) return;
      setTemplates(current => [template, ...current.filter(item => item.id !== template.id)]);
      setPublishing(false);
      notify('模板已发布到工作空间');
    });
  }
  function removeTemplate(template: StudioTemplate) {
    if (!window.confirm(`下架模板「${template.title}」？`)) return;
    void run('下架模板…', async () => {
      await studioRequest('', { action: 'removeTemplate', id: template.id });
      if (!mounted.current) return;
      setTemplates(current => current.filter(item => item.id !== template.id));
      notify('模板已下架');
    });
  }
  const canPublish = Boolean(record?.version && !dirty && document?.boards.length && document.boards.every(board => board.layers.every(layer => !layer.assetUrl)));
  const selectedBoard = document?.boards.find(board => board.id === selection?.boardId);
  const selectedName = selectedBoard?.layers.find(layer => layer.id === selection?.layerId)?.name ?? selectedBoard?.name;
  const coverImage = imageTask?.status === 'completed' ? imageTask.files.find(file => file.type.startsWith('image/')) : undefined;
  const assetBoard = selectedBoard ?? document?.boards[0];

  function openSurface(next: Surface) {
    if (busy) return;
    if (next === 'market') void loadMarket();
    if (next === 'assets' && !mediaLoading) void loadMedia();
    setSurface(next);
    setPublishing(false);
    setError('');
    setConflict(false);
  }

  function refreshMaterial(task: PublicMaterialTask) {
    void run('查询素材状态…', async () => {
      try {
        const { task: updated } = await studioRequest<{ task: PublicMaterialTask }>('', {
          action: 'refresh', taskId: task.id, version: task.version,
        }, '/api/marketing-materials');
        if (mounted.current) setMedia(current => current && { ...current, tasks: [updated, ...current.tasks.filter(item => item.id !== updated.id)] });
      } catch (error) {
        if (!(error instanceof StudioRequestError && error.status === 409)) throw error;
        await loadMedia();
      }
    });
  }

  function useImage(file: StudioImage) {
    if (!document || !assetBoard || assetBoard.layers.length >= 40) return;
    const layerId = crypto.randomUUID();
    update({ ...document, boards: document.boards.map(board => board.id !== assetBoard.id ? board : {
      ...board, layers: [...board.layers, {
        id: layerId, kind: 'image', name: file.name.slice(0, 100), assetUrl: file.url, text: '',
        x: 14, y: 18, width: 72, height: 62, fill: 'transparent', color: '#25272A',
        fontSize: 16, radius: 0, weight: 'normal', align: 'center',
      }],
    }) });
    setSelection({ boardId: assetBoard.id, layerId });
    setPanel('canvas');
    openSurface('project');
  }

  return <section className="creative-studio" data-surface={surface} aria-label="创作与设计工作台">
    {inProject && <aside className="creative-projects" aria-label="创作项目" data-mobile-expanded={projectListOpen}>
      <div className="creative-section-title"><h3><BookOpen size={17} /> 我的项目</h3>
        <button className="creative-mobile-projects" type="button" aria-expanded={projectListOpen}
          onClick={() => setProjectListOpen(value => !value)}><BookOpen size={16} /> 我的项目</button>
        <button type="button" disabled={busy} onClick={() => {
          openSurface('home');
        }} aria-label="新建创作项目"><Plus size={18} /></button>
      </div>
      <div className="creative-projects-body">
      <label className="creative-project-search">搜索项目<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="项目名称或类型" /></label>
      {loading && <p role="status">正在读取项目…</p>}
      {indexError && <p role="alert" className="material-error">{indexError} <button type="button" onClick={() => void loadIndex()}>重试</button></p>}
      <ul className="creative-project-list">
        {record?.version === 0 && <li><button type="button" aria-current="page" disabled={busy} onClick={() => openProject(record.id)}>
          <strong>{record.document.title || '未命名项目'}</strong><small>未保存 · {STUDIO_KIND_LABELS[record.document.kind]}</small>
        </button></li>}
        {filteredProjects.map(project => <li key={project.id}><button type="button" disabled={busy} aria-current={!market && record?.id === project.id ? 'page' : undefined}
          onClick={() => openProject(project.id)}>
          <strong>{project.title}</strong><small>{STUDIO_KIND_LABELS[project.kind]} · {stamp.format(new Date(project.updatedAt))}</small>
        </button></li>)}
      </ul>
      {!loading && !indexError && filteredProjects.length === 0 && !record && <p>{search ? '没有找到匹配的项目。' : '已保存的项目会显示在这里。'}</p>}
      </div>
    </aside>}
    <div className="creative-main">
      <header className="creative-toolbar">
        {inProject && document && record ?
          <form className="creative-title-form" onSubmit={save}>
            <label>项目名称<input value={document.title} maxLength={120} disabled={busy} required
              onChange={event => update({ ...document, title: event.target.value })} /></label>
            <span className="creative-save-state">{dirty ? '未保存' : `版本 ${record.version}`}</span>
            <button type="submit" className="creative-primary" disabled={busy || !dirty || !document.title.trim()}><Save size={16} /> 保存</button>
          </form> : <h3>{surface === 'home' ? '灵感墙' : surface === 'assets' ? '我的素材' : '模板与设计'}</h3>}
        <div className="creative-toolbar-actions">
          {surface !== 'home' && <button type="button" disabled={busy} onClick={() => openSurface(surface !== 'project' && record ? 'project' : 'home')}>
            <ArrowLeft size={16} /> {surface === 'project' ? '灵感墙' : '返回创作'}
          </button>}
          {surface !== 'assets' && <button type="button" disabled={busy} onClick={() => openSurface('assets')}><FolderOpen size={16} /> 素材库</button>}
          {!market && <button type="button" disabled={busy} onClick={() => openSurface('market')}><LayoutTemplate size={16} /> 设计市场</button>}
        </div>
      </header>
      {pending && <p className="creative-notice" role="status">{pending}</p>}
      {error && <div className="creative-notice material-error" role="alert">{error}
        {conflict && record && <button type="button" onClick={() => openProject(record.id, true)}><RotateCcw size={15} /> 读取最新保存版</button>}
      </div>}
      {market ? <div className="creative-page">
        {publishing && <form className="creative-publish" onSubmit={publish}>
          <h3>发布到工作空间</h3>
          <p>同一工作空间的成员可以复制这些画板。营销稿和创作资料留在项目中。</p>
          <label>模板名称<input value={templateTitle} onChange={event => setTemplateTitle(event.target.value)} maxLength={100} required disabled={busy} /></label>
          <label>模板简介<textarea value={templateDescription} onChange={event => setTemplateDescription(event.target.value)} maxLength={500} rows={2} required disabled={busy} /></label>
          <div className="creative-actions"><button type="submit" className="creative-primary" disabled={busy || !canPublish}>确认发布</button>
            <button type="button" disabled={busy} onClick={() => setPublishing(false)}>取消</button></div>
        </form>}
        <StudioMarket templates={templates} busy={busy} loading={marketLoading} error={marketError} onRetry={() => void loadMarket()}
          canPublish={canPublish} onChoose={template => start(template.kind, template)} onRemove={removeTemplate}
          onPublish={() => { setTemplateTitle(document?.title ?? ''); setTemplateDescription(''); setPublishing(true); }} />
        {document && !canPublish && <p>共享模板需要先保存项目，画板需移除私有图片。</p>}
      </div> : surface === 'assets' ? <div className="creative-page">
        <StudioAssets tasks={media?.tasks ?? []} loading={mediaLoading} busy={busy} error={assetError}
          onReload={() => void loadMedia()} onRefresh={refreshMaterial}
          onUseImage={assetBoard && assetBoard.layers.length < 40 ? useImage : undefined} />
      </div> : !inProject || !document || !record ? <div className="creative-start creative-page">
        <section className="creative-idea">
          <h3>今天想创作什么？</h3>
          <p>记下一句灵感，接着写成稿、做画板。</p>
          <form onSubmit={event => { event.preventDefault(); if (idea.trim()) start('poster', undefined, idea.trim()); }}>
            <label className="creative-idea-field"><span className="sr-only">记录灵感</span>
              <textarea rows={2} maxLength={8000} value={idea} onChange={event => setIdea(event.target.value)}
                placeholder="写下一句灵感，或贴上产品资料" disabled={busy} />
            </label>
            <button type="submit" className="creative-primary" disabled={busy || !idea.trim()}><ArrowUp size={16} /> 开始创作</button>
          </form>
        </section>
        <section className="creative-start-section" aria-label="新建创作">
        <div className="creative-collection-head"><h3>新建创作</h3></div>
        <div className="creative-start-grid">
          {previews.map(({ kind, board }) => {
            const Icon = iconByKind[kind];
            return <button className="creative-start-card" key={kind} type="button" disabled={busy} onClick={() => start(kind)} aria-label={titleByKind[kind]}>
              <span className="creative-start-preview" data-kind={kind} aria-hidden="true">
                {board && <BoardPreview board={board} images={[]} maxWidth={190} maxHeight={132} />}
              </span>
              <span className="creative-start-caption"><Icon size={16} /><strong>{titleByKind[kind]}</strong><ArrowUpRight size={15} /></span>
            </button>;
          })}
        </div>
        </section>
        <section className="creative-recent" aria-label="最近项目">
          <div className="creative-collection-head"><h3>最近项目</h3>
            {projects.length > 0 && <label><span className="sr-only">搜索项目</span><input type="search" value={search}
              onChange={event => setSearch(event.target.value)} placeholder="搜索项目" /></label>}
          </div>
          {loading && <p role="status">正在读取项目…</p>}
          {indexError && <p role="alert" className="material-error">{indexError} <button type="button" onClick={() => void loadIndex()}>重试</button></p>}
          {record?.version === 0 && <button className="creative-resume" type="button" onClick={() => openProject(record.id)} disabled={busy}>
            <FilePenLine size={16} /> 继续编辑「{record.document.title || '未命名项目'}」
          </button>}
          {!loading && !indexError && !filteredProjects.length && record?.version !== 0 &&
            <p>{search ? '没有找到匹配的项目。' : '开始创作后，保存的项目会显示在这里。'}</p>}
          <ul className="creative-recent-grid">
            {filteredProjects.map(project => <li key={project.id}><button type="button" disabled={busy} onClick={() => openProject(project.id)}>
              <strong>{project.title}</strong><small>{STUDIO_KIND_LABELS[project.kind]} · {stamp.format(new Date(project.updatedAt))}</small>
            </button></li>)}
          </ul>
        </section>
      </div> : <>
        <div className="creative-project-nav">
          <nav aria-label="项目工作区">
            {(Object.keys(panelLabels) as Panel[]).map(item => <button type="button" key={item} disabled={busy} aria-pressed={panel === item}
              onClick={() => setPanel(item)}>{panelLabels[item]}</button>)}
          </nav>
          {record.version > 0 && <button type="button" disabled={busy || dirty} onClick={archive}><Archive size={15} /> 归档</button>}
        </div>
        <div className="creative-page">
          {panel === 'content' && <>
            {imageTask && <div className="creative-notice" role="status">
              封面图片：{imageStates[imageTask.status]}{imageTask.error ? ` · ${imageTask.error}` : ''}
              {!terminalImages.includes(imageTask.status) && imageTask.status !== 'submission_unknown' &&
                <button type="button" disabled={busy} onClick={() => image('refresh')}>查询进度</button>}
              {imageTask.status === 'submission_unknown' && <button type="button" disabled={busy} onClick={() => void loadMedia()}>刷新素材记录</button>}
              {imageTask.status === 'completed' && <button type="button" onClick={() => setPanel('canvas')}>打开设计画布</button>}
            </div>}
            <StudioContent key={record.id} document={document} onChange={update} busy={busy} modelAvailable={modelAvailable}
              canDesign={document.boards.length < MAX_BOARDS} needsSaveForImage={Boolean(media?.availability.image && !record.version)}
              coverImage={coverImage}
              canGenerateImage={Boolean(record.version && media?.availability.image && !mediaLoading &&
                (!imageTask || terminalImages.includes(imageTask.status)))}
              onGenerate={instruction => generate('copy', instruction)} onCreateDesign={fromCopy} onGenerateImage={() => image('generate')}
              onScheduleBusy={setScheduleBusy} notify={notify} />
          </>}
          {panel === 'canvas' && <>
            <div className="creative-design-controls">
              <button type="button" className="creative-primary" disabled={busy || !modelAvailable || document.boards.length >= MAX_BOARDS || !document.brief.trim()}
                onClick={() => generate('design')}><Sparkles size={16} /> 生成设计方向</button>
              <button type="button" disabled={busy} onClick={() => void loadMedia()}><RotateCcw size={15} /> 刷新素材</button>
              <label>修改{selectedName ? `「${selectedName}」` : '选中内容'}
                <input maxLength={1000} value={revisionNote} disabled={busy} placeholder="例如，标题放大，背景换成浅蓝色"
                  onChange={event => setRevisionNote(event.target.value)} />
              </label>
              <button type="button" disabled={busy || !modelAvailable || !selection || !revisionNote.trim()}
                onClick={() => generate('revise', revisionNote.trim())}>修改选中内容</button>
            </div>
            {assetError && <p className="material-error" role="alert">素材库暂不可用。{assetError}</p>}
            {!modelAvailable && <p>可以在画布上手动编辑。AI 生成需要启用工作台的大模型。</p>}
            {modelAvailable && !document.brief.trim() && <p>先在「成稿」填写设计需求，就能生成多个设计方向。</p>}
            <StudioCanvas document={document} onChange={update} selection={selection} onSelectionChange={setSelection}
              images={images} disabled={busy} notify={notify} />
          </>}
          {panel === 'versions' && <StudioVersions key={record.id} id={record.id} document={document} versions={versions}
            disabled={busy} images={images} onRestore={restore} />}
        </div>
      </>}
    </div>
  </section>;
}
