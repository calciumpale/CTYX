'use client';

import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleAlert, Download, FileText, Plus, RotateCcw, Save, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { StudioRequestError, studioRequest } from '../lib/creative-studio-client';
import { buildGeoStructuredData } from '../lib/geo-structured-data';
import { emptyGeoDocument, emptyGeoWorkflow, GEO_STATUS_LABELS, type GeoArticle, type GeoBrief, type GeoCaptureResponse, type GeoDocument, type GeoGap, type GeoObservation, type GeoPhase, type GeoProject, type GeoQuality, type GeoStatus, type GeoSummary, type GeoWorkflow } from '../lib/geo-types';
import type { MemberSession } from '../lib/member-types';
import { preferredScrollBehavior } from '../lib/scroll-behavior';
import GeoKnowledgePicker from './GeoKnowledgePicker';
import { GeoIllustration } from './VisualIllustrations';
import {
  availableSlots, downloadGeoFile, downloadGeoReport, emptyCapture, GeoAiCaptureControls, GeoAnswerCapture, GeoAnswerLog,
  GEO_CAPTURE_PROVIDER_LABELS, GeoGapEditor, GeoGapSources, GeoPlanEditor, GeoRetestComparison, GeoVisibility, hasCaptureDraft,
  type CaptureDraft, type CaptureInput, type GeoCaptureEngine, type GeoCaptureModel, type GeoCaptureProgress, type GeoCaptureRecovery, type GeoPlan, type GeoSampleSlot,
} from './GeoWorkflowPanels';
import './geo-workspace.css';

const PATH = '/api/geo';
const AI_BATCH_SIZE = 4;
const GAP_GENERATION_LIMIT = 8;
const STEPS = [
  { title: '提问空间建模', detail: '品牌、问题与采样范围' },
  { title: '答案级抓取', detail: '答案、引用和提及位次' },
  { title: '信源缺口诊断', detail: '可见性与补齐优先级' },
  { title: '结构化补齐与复测', detail: '内容交付与前后验证' },
] as const;
type GeoStep = 0 | 1 | 2 | 3;
type AiOperation = 'start' | 'query' | 'retry';
type PhaseState<T> = Partial<Record<GeoPhase, T>>;
type GeoTextSource = { provider?: 'apimart' | 'workspace'; model?: string };
type CatalogModel = { model: string; webSearch: boolean; provider?: GeoCaptureModel['provider'] };
type AiCaptureAvailability = {
  engines: string[];
  models?: Record<string, CatalogModel>;
  providers?: Record<GeoCaptureModel['provider'], Record<string, CatalogModel>>;
  apimart?: { status: 'ready' | 'disabled' | 'no_text_models' | 'error'; message?: string };
  apimartMessage?: string;
};
const NO_AI_CAPTURE: AiCaptureAvailability = { engines: [] };
const normalizeEngine = (value: string) => value.normalize('NFKC').trim().toLowerCase();
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
const EMPTY_WORKFLOW = emptyGeoWorkflow();
const readPlan = ({ questions, engines, repeats, competitors }: GeoWorkflow): GeoPlan => ({ questions, engines, repeats, competitors });
const EMPTY_PLAN = readPlan(EMPTY_WORKFLOW);
const initialCaptures = () => ({ baseline: emptyCapture(), retest: emptyCapture() });

function validPlanNames(values: string[]) {
  const names = values.map(normalizeEngine);
  return names.every(Boolean) && new Set(names).size === names.length;
}

function captureRecovery(workflow: GeoWorkflow, slots: GeoSampleSlot[], phase: GeoPhase, local?: GeoCaptureRecovery) {
  if (local && slots.some(slot => slot.sampleKey === local.sampleKey)) return local;
  const keys = new Set(slots.map(slot => slot.sampleKey));
  const latest = workflow.captureAttempts?.filter(item => item.slot.phase === phase && keys.has(item.sampleKey))
    .sort((first, second) => second.startedAt.localeCompare(first.startedAt))[0];
  return latest && latest.status !== 'saved' ? { id: latest.id, status: latest.status, sampleKey: latest.sampleKey, message: latest.message } : undefined;
}

function textSourceLabel({ provider, model }: GeoTextSource) {
  return provider ? [GEO_CAPTURE_PROVIDER_LABELS[provider], model].filter(Boolean).join(' · ') : '';
}

function captureModels(availability: AiCaptureAvailability) {
  const map = (values: Record<string, CatalogModel> | undefined, provider: GeoCaptureModel['provider']): Map<string, GeoCaptureModel> =>
    new Map(Object.entries(values ?? {}).map(([engine, model]) => [normalizeEngine(engine), { ...model, provider: model.provider ?? provider }]));
  const providers = { apimart: map(availability.providers?.apimart, 'apimart'), workspace: map(availability.providers?.workspace, 'workspace') };
  const combined = map(availability.models, 'apimart');
  const legacyEngines = new Set(availability.engines.map(normalizeEngine));
  const current = (engine: string): GeoCaptureModel | undefined => {
    const key = normalizeEngine(engine);
    return providers.apimart.get(key) ?? providers.workspace.get(key) ?? combined.get(key) ??
      (legacyEngines.has(key) && !availability.providers ? { provider: 'apimart' } : undefined);
  };
  return {
    displayed: availability.engines.flatMap(engine => {
      const model = current(engine);
      return model ? [{ engine, ...model }] : [];
    }),
    forSlot(slot: GeoSampleSlot): GeoCaptureModel | undefined {
      const planned = current(slot.engine);
      if (!slot.baseline) return planned;
      const baseline = slot.baseline.provenance;
      if (!baseline) return undefined;
      if (!availability.providers) {
        return planned?.provider === baseline.provider && (!planned.model || planned.model === baseline.model) ? baseline : undefined;
      }
      const providerModels = providers[baseline.provider];
      const engineModel = providerModels.get(normalizeEngine(slot.engine));
      const originalModel = providerModels.get(normalizeEngine(baseline.model));
      return engineModel?.webSearch === baseline.webSearch &&
        (engineModel.model === baseline.model || originalModel?.model === baseline.model) ? baseline : undefined;
    },
  };
}

function summarizeCaptureBatch(slots: GeoSampleSlot[], modelFor: (slot: GeoSampleSlot) => GeoCaptureModel | undefined) {
  const groups = new Map<string, GeoCaptureEngine>();
  for (const slot of slots) {
    const model = modelFor(slot);
    if (!model) continue;
    const key = JSON.stringify([slot.engine, model.provider, model.model, model.webSearch]);
    const existing = groups.get(key);
    groups.set(key, { engine: slot.engine, ...model, slots: (existing?.slots ?? 0) + 1 });
  }
  return [...groups.values()];
}

function apimartStatusNote(availability: AiCaptureAvailability) {
  if (!availability.apimart) return availability.apimartMessage;
  if (availability.apimart.status === 'ready') return undefined;
  return availability.apimart.message || {
    disabled: 'APIMart 文本采样连接尚未启用。',
    no_text_models: '当前 APIMart 连接没有 GEO 可用的文本模型。',
    error: 'APIMart 的连接暂时不可用。',
  }[availability.apimart.status];
}

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
  downloadGeoFile(title || 'GEO 稿件', 'md', 'text/markdown', markdown);
}

function Status({ status }: { status: GeoStatus }) {
  return <span className="geo-status" data-status={status}>{GEO_STATUS_LABELS[status]}</span>;
}

function BriefEditor({ brief, onChange, disabled }: {
  brief: GeoBrief; onChange: (brief: GeoBrief) => void; disabled: boolean;
}) {
  return <fieldset className="geo-fields" disabled={disabled}>
    <legend className="geo-visually-hidden">建模范围</legend>
    <div className="geo-field-triple">
      <label>品牌<input className="input" value={brief.brand} maxLength={120} onChange={e => onChange({ ...brief, brand: e.target.value })} /></label>
      <label>选题<input className="input" value={brief.topic} maxLength={120} onChange={e => onChange({ ...brief, topic: e.target.value })} /></label>
      <label>目标受众<input className="input" value={brief.audience} maxLength={300} onChange={e => onChange({ ...brief, audience: e.target.value })} /></label>
    </div>
    <label>用户主要问题<textarea className="textarea" rows={2} value={brief.question} maxLength={600}
      placeholder="例如：选择园区办公空间时，需要核对哪些条件？" onChange={e => onChange({ ...brief, question: e.target.value })} /></label>
  </fieldset>;
}

function SourceEditor({ brief, onChange, onRemoveSource, editable, busy }: {
  brief: GeoBrief; onChange: (brief: GeoBrief) => void; onRemoveSource: (index: number) => void; editable: boolean; busy: boolean;
}) {
  return <fieldset className="geo-fields" disabled={busy || !editable}>
    <legend className="geo-visually-hidden">可信来源</legend>
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
    {editable && <div className="geo-actions"><button type="button" className="button ghost" disabled={brief.sources.length >= 8}
      onClick={() => onChange({ ...brief, sources: [...brief.sources, { title: '', url: '', excerpt: '' }] })}><Plus size={15} aria-hidden="true" />添加来源</button></div>}
  </fieldset>;
}

function ArticleEditor({ article, onChange, disabled }: { article: GeoArticle; onChange: (article: GeoArticle) => void; disabled: boolean }) {
  return <fieldset className="geo-fields" disabled={disabled}>
    <legend className="geo-visually-hidden">文章内容</legend>
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
  const [plan, setPlan] = useState(EMPTY_PLAN);
  const [gaps, setGaps] = useState<GeoGap[]>([]);
  const [captures, setCaptures] = useState(initialCaptures);
  const [checked, setChecked] = useState<{ document: GeoDocument; quality: GeoQuality }>();
  const [forms, setForms] = useState(initialForms);
  const [capabilities, setCapabilities] = useState<
    | { status: 'loading' | 'error' }
    | { status: 'ready'; modelAvailable: boolean; aiCapture: AiCaptureAvailability }
  >({ status: 'loading' });
  const [aiPhase, setAiPhase] = useState<GeoPhase>();
  const [aiProgress, setAiProgress] = useState<PhaseState<GeoCaptureProgress>>({});
  const [recoveries, setRecoveries] = useState<PhaseState<GeoCaptureRecovery>>({});
  const [diagnosisSource, setDiagnosisSource] = useState('');
  const [articleSource, setArticleSource] = useState('');
  const [stoppingAi, setStoppingAi] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [step, setStep] = useState<GeoStep>(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const stopAi = useRef(false);
  const listRequest = useRef<AbortController | null>(null);
  const capabilitiesRequest = useRef<AbortController | null>(null);
  const qualityRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const focusStepFrame = useRef<number | null>(null);
  const busy = Boolean(pending);
  const changed = Boolean(draft && project && JSON.stringify(draft) !== JSON.stringify(project.document));
  const workflow = project?.workflow ?? EMPTY_WORKFLOW;
  const savedBrand = project?.document.brief.brand ?? '';
  const modelAvailable = capabilities.status === 'ready' && capabilities.modelAvailable;
  const aiCapture = capabilities.status === 'ready' ? capabilities.aiCapture : NO_AI_CAPTURE;
  const sampling = useMemo(() => captureModels(aiCapture), [aiCapture]);
  const aiSlots = useMemo(() => {
    const eligible = (phase: GeoPhase) => availableSlots(workflow, phase, savedBrand, 'automatic');
    return {
      baseline: savedBrand && workflow.answers.length < 600 ? eligible('baseline') : [],
      retest: savedBrand && project?.publication && workflow.answers.length < 600 ? eligible('retest') : [],
    };
  }, [workflow, savedBrand, project?.publication]);
  const hasCurrentBaseline = workflow.answers.some(answer => answer.phase === 'baseline' && answer.brand === savedBrand);
  const structure = step === 3 && project?.version ? buildGeoStructuredData(project.document, project.publication) : null;
  const planChanged = Boolean(project && JSON.stringify(plan) !== JSON.stringify(readPlan(workflow)));
  const planInvalid = plan.questions.some(item => !item.prompt.trim()) || !validPlanNames(plan.engines) || !validPlanNames(plan.competitors);
  const gapsChanged = Boolean(project && JSON.stringify(gaps) !== JSON.stringify(workflow.gaps));
  const captureChanged = Object.values(captures).some(hasCaptureDraft);
  const dirty = changed || planChanged || gapsChanged || captureChanged || Object.values(forms).some(value => value.trim().length > 0);
  const canEditWorkflow = project?.canEditWorkflow ?? Boolean(project?.canEdit || project?.canRecord);
  const checkpoints = [workflow.questions.length > 0 && workflow.engines.length > 0,
    workflow.answers.some(answer => answer.phase === 'baseline'), workflow.gaps.length > 0,
    Boolean(project?.publication && workflow.answers.some(answer => answer.phase === 'retest'))];
  const quality = checked?.document === draft ? checked?.quality ?? null : !changed && project?.version ? project.quality : null;
  const readyIdentity = Boolean(draft?.brief.brand.trim() && draft.brief.topic.trim() && draft.brief.question.trim());
  const readyBrief = readyIdentity && Boolean(draft?.brief.sources.some(source => source.title.trim() &&
    (!source.url.trim() || httpsUrl(source.url)) && source.excerpt.trim()));
  const currentAnswerIds = new Set(workflow.answers.filter(answer => answer.brand === savedBrand && answer.phase === 'baseline').map(answer => answer.id));
  const generationGaps = workflow.gaps.filter(gap => gap.status === 'open' && gap.evidenceAnswerIds.some(id => currentAnswerIds.has(id)))
    .sort((first, second) => first.priority.localeCompare(second.priority)).slice(0, GAP_GENERATION_LIMIT);
  const readyGuidedBrief = readyIdentity && Boolean(project?.version && generationGaps.length && draft?.brief.brand.trim() === savedBrand);

  const loadList = useCallback(async () => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true);
    setListError('');
    try {
      const result = await studioRequest<{ projects: GeoSummary[] }>('?scope=projects', undefined, PATH, { signal: controller.signal });
      if (!Array.isArray(result.projects)) throw new Error('无法读取项目列表，请重试。');
      if (!controller.signal.aborted) {
        setProjects(result.projects);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setListError(cause instanceof Error ? cause.message : '读取项目失败，请重试。');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const loadCapabilities = useCallback(async (priority: RequestPriority = 'low') => {
    capabilitiesRequest.current?.abort();
    const controller = new AbortController();
    capabilitiesRequest.current = controller;
    setCapabilities({ status: 'loading' });
    try {
      const result = await studioRequest<{ modelAvailable: boolean; aiCapture?: AiCaptureAvailability }>(
        '?scope=capabilities', undefined, PATH, { signal: controller.signal, priority },
      );
      if (typeof result.modelAvailable !== 'boolean') throw new Error('无效的模型状态');
      if (!controller.signal.aborted) {
        setCapabilities({ status: 'ready', modelAvailable: result.modelAvailable, aiCapture: result.aiCapture ?? NO_AI_CAPTURE });
      }
    } catch {
      if (!controller.signal.aborted) setCapabilities({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => {
      void loadList();
      void loadCapabilities();
    }, 0);
    return () => {
      mounted.current = false;
      window.clearTimeout(timer);
      listRequest.current?.abort();
      capabilitiesRequest.current?.abort();
      if (focusStepFrame.current !== null) window.cancelAnimationFrame(focusStepFrame.current);
    };
  }, [loadList, loadCapabilities]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onDirtyChange?.(false); onBusyChange?.(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => {
    if (checked && checked.document === draft) {
      qualityRef.current?.scrollIntoView({ block: 'nearest', behavior: preferredScrollBehavior() });
    }
  }, [checked, draft]);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: preferredScrollBehavior() });
  }, [error]);

  function applyProject(next: GeoProject) {
    setProject(next);
    setDraft(next.document);
    setPlan(readPlan(next.workflow ?? EMPTY_WORKFLOW));
    setGaps(next.workflow?.gaps ?? []);
    setCaptures(initialCaptures());
    if (project?.id !== next.id) {
      setAiProgress({});
      setRecoveries({});
    }
    setDiagnosisSource('');
    setArticleSource('');
    setChecked(undefined);
    setForms(initialForms);
    setProjectsOpen(false);
  }

  function goToStep(next: GeoStep) {
    setStep(next);
    if (focusStepFrame.current !== null) window.cancelAnimationFrame(focusStepFrame.current);
    focusStepFrame.current = window.requestAnimationFrame(() => {
      focusStepFrame.current = null;
      stepHeading.current?.focus({ preventScroll: true });
      stepHeading.current?.scrollIntoView({ block: 'nearest' });
    });
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
    goToStep(0);
    setError('');
    setConflict(false);
  }

  function open(id: string, reload = false) {
    if (project?.id === id && !reload) { setProjectsOpen(false); return; }
    if (!canLeave()) return;
    void run('正在读取项目…', async () => {
      const response = await readProject(id);
      if (mounted.current) {
        applyProject(response.project);
        goToStep(reload ? step : response.project.status === 'draft' ? 0 : 3);
      }
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

  function rememberProject(next: GeoProject) {
    setProject(next);
    if (loading) {
      void loadList();
    } else {
      setProjects(current => [{
        id: next.id, topic: next.document.brief.topic, title: next.document.article.title,
        status: next.status, updatedAt: next.updatedAt, mine: current.find(item => item.id === next.id)?.mine ?? true,
      }, ...current.filter(item => item.id !== next.id)]);
    }
  }

  function mutate(action: 'save' | 'submit' | 'review' | 'publish' | 'observe' | 'workflow' | 'capture' | 'gaps', fields: object, pendingText: string, success: string,
    onSuccess?: () => void) {
    if (!project) return;
    void run(pendingText, async () => {
      const response = await postGeo<{ project: GeoProject }>({ action, id: project.id, version: project.version, ...fields });
      if (!mounted.current) return;
      const next = response.project;
      rememberProject(next);
      if (action === 'save') {
        setDraft(next.document);
        setChecked(undefined);
      }
      if (action === 'workflow' || (action === 'save' && 'workflow' in fields)) setPlan(readPlan(next.workflow ?? EMPTY_WORKFLOW));
      if (action === 'gaps') setGaps(next.workflow?.gaps ?? []);
      if (action === 'review') setForms(current => ({ ...current, reviewNote: '' }));
      if (action === 'publish') setForms(current => ({ ...current, url: '', channel: '' }));
      if (action === 'observe') setForms(current => ({ ...current, engine: '', query: '', result: '', evidence: '' }));
      if (action !== 'save' && action !== 'workflow' && action !== 'capture' && action !== 'gaps' && !changed) setDraft(next.document);
      notify(success);
      onSuccess?.();
    }, true);
  }

  function savePlan() {
    if (!project || !draft || !canEditWorkflow || planInvalid) return;
    if (project.canEdit) {
      mutate('save', { document: draft, workflow: plan }, '正在保存建模…', '建模已保存');
    } else {
      mutate('workflow', { workflow: plan }, '正在保存建模…', '建模已保存');
    }
  }

  function recordCapture(answer: CaptureInput) {
    mutate('capture', { answer }, '正在保存答案记录…', '答案记录已保存',
      () => setCaptures(current => ({ ...current, [answer.phase]: emptyCapture() })));
  }

  function captureState(phase: GeoPhase) {
    const slots = aiSlots[phase];
    const supported = slots.filter(slot => sampling.forSlot(slot));
    const recovery = captureRecovery(workflow, supported.length ? supported : slots, phase, recoveries[phase]);
    return { slots, supported, recovery };
  }

  function runAiCapture(phase: GeoPhase, operation: AiOperation) {
    if (!project?.version || !canEditWorkflow || inFlight.current || hasCaptureDraft(captures[phase])) return;
    const { slots, supported, recovery } = captureState(phase);
    const batch = operation === 'start' ? supported.slice(0, AI_BATCH_SIZE)
      : slots.filter(slot => slot.sampleKey === recovery?.sampleKey && (operation === 'query' || sampling.forSlot(slot)));
    if (!batch.length || (operation === 'start' && recovery) ||
      (operation === 'retry' && (!recovery || recovery.status === 'running'))) return;
    if (operation === 'retry' && recovery?.status === 'unknown' && !window.confirm('重新发起会提交一次新的模型调用，可能产生新的费用。继续？')) return;
    const total = batch.length;
    const label = phase === 'baseline' ? 'AI 基线采样' : 'AI 复测';
    const engines = operation === 'query' ? [] : summarizeCaptureBatch(batch, sampling.forSlot);
    const update = (completed: number, message: string) => setAiProgress(current => ({ ...current, [phase]: { completed, total, message, engines } }));
    const remember = (next?: GeoCaptureRecovery) => setRecoveries(current => ({ ...current, [phase]: next }));
    stopAi.current = false;
    setStoppingAi(false);
    setAiPhase(phase);
    void run(`正在执行${label}…`, async () => {
      let current = project;
      let completed = 0;
      try {
        for (const slot of batch) {
          if (stopAi.current || !mounted.current) break;
          const requestId = operation === 'query' && recovery ? recovery.id : crypto.randomUUID();
          const model = operation === 'query' ? undefined : sampling.forSlot(slot);
          const source = model ? `（${textSourceLabel(model)}）` : '';
          update(completed, `已保存 ${completed} / ${total} 份，正在${operation === 'query' ? '查询' : '处理'} ${slot.engine} 第 ${slot.sample} 次${source}。`);
          const request = { action: 'capture_ai', id: current.id, version: current.version,
            slot: { questionId: slot.questionId, engine: slot.engine, sample: slot.sample, phase }, requestId };
          let result: GeoCaptureResponse;
          try {
            result = await postGeo<typeof result>(request);
          } catch (cause) {
            if (mounted.current) {
              if (!(cause instanceof StudioRequestError) || cause.status >= 500) {
                remember({ id: requestId, sampleKey: slot.sampleKey, status: 'unknown', message: '未能确认上次请求是否完成。' });
              }
              update(completed, `本批已保存 ${completed} / ${total} 份，后续位置尚未处理。`);
            }
            throw cause;
          }
          if (!mounted.current) return;
          current = result.project;
          rememberProject(current);
          if (result.capture.status !== 'saved') {
            remember({ id: requestId, sampleKey: slot.sampleKey, status: result.capture.status, message: result.capture.message });
            update(completed, `本批已保存 ${completed} / ${total} 份，当前样本尚未保存。`);
            return;
          }
          remember();
          completed += 1;
        }
        if (!mounted.current) return;
        update(completed, stopAi.current && completed < total
          ? `已停止本批，保存了 ${completed} / ${total} 份。` : `本批已保存 ${completed} 份答案。`);
      } finally {
        if (mounted.current) {
          setAiPhase(undefined);
          setStoppingAi(false);
        }
      }
    }, true);
  }

  function aiCaptureControls(phase: GeoPhase) {
    const { supported, recovery } = captureState(phase);
    const nextBatch = recovery ? supported.filter(slot => slot.sampleKey === recovery.sampleKey) : supported.slice(0, AI_BATCH_SIZE);
    return <GeoAiCaptureControls phase={phase} serviceAvailable={sampling.displayed.length > 0} connectionNote={apimartStatusNote(aiCapture)}
      capabilitiesReady={capabilities.status === 'ready'}
      batch={summarizeCaptureBatch(nextBatch, sampling.forSlot)} available={supported.length} batchSize={AI_BATCH_SIZE}
      active={aiPhase === phase} stopping={stoppingAi} progress={aiProgress[phase]} disabled={busy || hasCaptureDraft(captures[phase])}
      manualDraft={hasCaptureDraft(captures[phase])} recovery={recovery} canRetry={supported.some(slot => slot.sampleKey === recovery?.sampleKey)}
      onStart={() => runAiCapture(phase, 'start')} onQuery={() => runAiCapture(phase, 'query')} onRetry={() => runAiCapture(phase, 'retry')}
      onStop={() => { stopAi.current = true; setStoppingAi(true); }} />;
  }

  function saveGaps() {
    if (gaps.some(gap => !gap.title.trim() || !gap.action.trim() || !gap.evidenceAnswerIds.length)) {
      setError('每条缺口需要标题、补齐建议和至少一条关联答案证据。');
      return;
    }
    mutate('gaps', { gaps }, '正在保存缺口清单…', '缺口清单已保存');
  }

  function diagnose() {
    if (!project || !modelAvailable || !hasCurrentBaseline) return;
    if (gapsChanged && !window.confirm('用新生成的建议替换当前未保存的缺口编辑？')) return;
    void run('正在诊断信源缺口…', async () => {
      const response = await postGeo<{ gaps: GeoGap[] } & GeoTextSource>({ action: 'diagnose', id: project.id, version: project.version });
      if (!mounted.current) return;
      const existing = project.workflow?.gaps ?? [];
      setGaps([...existing, ...response.gaps].slice(0, 60));
      setDiagnosisSource(textSourceLabel(response));
      notify(response.gaps.length ? '缺口建议已生成。核对证据后保存。' : '本批答案未生成可核实的缺口建议。');
    }, true);
  }

  function generate(useGaps = false) {
    if (!draft || !modelAvailable || (useGaps ? !readyGuidedBrief : !readyBrief)) return;
    if ((draft.article.title || draft.article.markdown || draft.article.summary || draft.article.faq.length) &&
      !window.confirm('用新生成的稿件替换当前稿件？')) return;
    void run('正在生成稿件…', async () => {
      const basis = useGaps && project
        ? { id: project.id, version: project.version, gapIds: generationGaps.map(gap => gap.id) } : {};
      const response = await postGeo<{ article: GeoArticle; evidencePending?: boolean } & GeoTextSource>({ action: 'generate', brief: draft.brief, ...basis });
      if (!mounted.current) return;
      const document = { ...draft, article: response.article };
      updateDraft(document);
      setArticleSource(textSourceLabel(response));
      notify(response.evidencePending ? '补齐框架已生成，补充可核对的来源后再提交。' : '稿件已生成，核对事实和引用后保存。');
      if (useGaps) {
        setPending('正在检查稿件…');
        const { quality } = await postGeo<{ quality: GeoQuality }>({ action: 'check', document });
        if (mounted.current) setChecked({ document, quality });
      }
    }, useGaps);
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

  const showEmptyOnboarding = !loading && !listError && !projects.length && !project;

  return <section className="geo-workspace" aria-label="GEO 内容优化" data-empty={showEmptyOnboarding}>
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
      </div>
    </aside>
    <div className="geo-main" role="region" aria-label="GEO 项目内容" tabIndex={0}>
      {showEmptyOnboarding && <header className="geo-page-header">
        <div>
          <h2>GEO 内容优化</h2>
          <p>围绕目标客户真实提问追踪 AI 回答与引用表现，定位信源缺口并在发布后复测。</p>
        </div>
        <button type="button" className="button secondary" disabled={busy} onClick={start}><Plus size={15} aria-hidden="true" />立即新建</button>
      </header>}
      {project && step > 0 && <div className="geo-capabilities" data-ready={capabilities.status === 'ready'}>
        <p className="geo-muted" role="status">{capabilities.status === 'loading' ? '正在读取 AI 服务状态…' : capabilities.status === 'error'
          ? '暂时无法读取 AI 服务状态。' : modelAvailable ? 'AI 服务状态已更新。' : '当前未发现可用的生成模型。'}</p>
        {(capabilities.status === 'error' || (capabilities.status === 'ready' && aiCapture.apimart?.status === 'error')) &&
          <button type="button" className="button ghost" onClick={() => void loadCapabilities('auto')}>重试读取 AI 服务</button>}
      </div>}
      {pending && <p role="status" className="geo-notice">{pending}</p>}
      {error && <div role="alert" className="geo-alert" ref={errorRef}>{error}
        {conflict && project && <button type="button" className="button secondary" disabled={busy} onClick={() => open(project.id, true)}><RotateCcw size={15} aria-hidden="true" />读取最新版本</button>}
      </div>}
      {!project || !draft ? <div className="geo-empty-stage">
        <div className="geo-empty">
          <GeoIllustration className="geo-empty-art" />
          <div className="geo-empty-engines" aria-hidden="true"><span>DeepSeek</span><span>豆包</span><span>Kimi</span><span>通义千问</span></div>
          <h3>查看品牌在 AI 回答中的表现</h3>
          <p>从用户可能提出的问题出发，记录实际答案和引用，找出需要补齐的信源，并在发布后复测。</p>
          <ol className="geo-empty-steps" aria-hidden="true">
            {STEPS.map((item, idx) => <li key={item.title}><span>0{idx + 1}</span><strong>{item.title}</strong><small>{item.detail}</small></li>)}
          </ol>
          <button type="button" className="button primary" disabled={busy} onClick={start}><Plus size={16} aria-hidden="true" />新建内容项目</button>
        </div>
      </div> : <>
        <header className="geo-header">
          <div>
            <div className="geo-title"><h3>{draft.article.title || draft.brief.topic || '新建内容项目'}</h3><Status status={project.status} /></div>
            <p className="geo-muted">{dirty || !project.version ? '有未保存的编辑' : `版本 ${project.version} · ${timestamp.format(new Date(project.updatedAt))}`}</p>
          </div>
          <div className="geo-actions">
            {step === 0 && canEditWorkflow && <button type="button" className="button primary" disabled={busy || planInvalid || (!changed && !planChanged)}
              onClick={savePlan}><Save size={16} aria-hidden="true" />保存建模</button>}
            {step === 3 && project.canEdit && <>
              <button type="button" className="button secondary" disabled={busy} onClick={check}>检查质量</button>
              <button type="button" className="button primary" disabled={busy || !changed}
                onClick={() => mutate('save', { document: draft }, '正在保存草稿…', '草稿已保存')}><Save size={16} aria-hidden="true" />保存草稿</button>
            </>}
            {step === 3 && (project.status === 'approved' || project.status === 'published') &&
              <button type="button" className="button primary" disabled={busy} onClick={() => downloadMarkdown(project.document)}><Download size={16} aria-hidden="true" />导出 Markdown</button>}
            {structure && <button type="button" className="button secondary" disabled={busy}
              onClick={() => downloadGeoFile(`${project.document.article.title} - 结构化数据`, 'json', 'application/ld+json', JSON.stringify(structure, null, 2) + '\n')}>
              <Download size={16} aria-hidden="true" />导出结构化数据
            </button>}
          </div>
        </header>
        <nav aria-label="GEO 工作流程" className="geo-steps">
          <ol>{STEPS.map((item, index) => <li key={item.title}>
            <button type="button" data-complete={checkpoints[index]} aria-label={item.title}
              aria-describedby={`geo-step-description-${index}`} aria-current={index === step ? 'step' : undefined}
              aria-controls="geo-step-content" disabled={busy} onClick={() => goToStep(index as GeoStep)}>
              <span className="geo-step-index" aria-hidden="true">{checkpoints[index] && index !== step ? <Check size={15} /> : index + 1}</span>
              <span className="geo-step-label"><strong>{item.title}</strong><small id={`geo-step-description-${index}`}>{item.detail}{checkpoints[index] ? ' · 已有记录' : ''}</small></span>
            </button>
          </li>)}</ol>
        </nav>
        <section className="geo-step-content" id="geo-step-content" aria-labelledby="geo-active-step">
          <div className="geo-step-heading">
            <h3 key={step} ref={stepHeading} id="geo-active-step" tabIndex={-1}>{STEPS[step].title}</h3>
            <div className="geo-actions">
              {step > 0 && <button type="button" className="button ghost" disabled={busy} onClick={() => goToStep((step - 1) as GeoStep)}><ArrowLeft size={15} aria-hidden="true" />上一步</button>}
              {step < 3 && <button type="button" className="button secondary" disabled={busy} onClick={() => goToStep((step + 1) as GeoStep)}>下一步<ArrowRight size={15} aria-hidden="true" /></button>}
            </div>
          </div>
          {step === 0 && <>
            <section className="geo-panel" aria-label="建模范围">
              <h3>建模范围</h3>
              <BriefEditor brief={draft.brief} disabled={busy || !project.canEdit}
                onChange={brief => updateDraft({ ...draft, brief })} />
            </section>
            <GeoPlanEditor plan={plan} mainQuestion={draft.brief.question} disabled={busy || !canEditWorkflow} onChange={setPlan} aiEngines={sampling.displayed} />
            {planInvalid && <p className="geo-muted">请填写每条追踪问题与引擎、竞品名称，再移除重复的引擎或竞品名称。</p>}
          </>}
          {step === 1 && <>
            <section className="geo-panel" aria-label="基线采样">
              <h3>基线采样</h3>
              {(planChanged || draft.brief.brand !== savedBrand) && <p className="geo-muted">采样按已保存的计划执行。要应用当前的更改，请先保存建模。</p>}
              {canEditWorkflow && project.version > 0 && savedBrand.trim() ? <>
                {aiCaptureControls('baseline')}
                <GeoAnswerCapture workflow={workflow} brand={savedBrand} phase="baseline" draft={captures.baseline} disabled={busy}
                  onChange={(next: CaptureDraft) => setCaptures(current => ({ ...current, baseline: next }))} onSave={recordCapture} />
              </> : <p className="geo-muted">{canEditWorkflow ? '保存品牌、追踪问题和引擎后，即可采样。' : '项目作者可以保存基线答案。'}</p>}
            </section>
            <section className="geo-panel" aria-label="基线答案记录">
              <div className="geo-field-heading"><h3>基线答案记录</h3><span className="geo-count">{workflow.answers.filter(answer => answer.phase === 'baseline').length} 份</span></div>
              <GeoAnswerLog answers={workflow.answers} phase="baseline" />
            </section>
          </>}
          {step === 2 && <>
            <GeoVisibility workflow={workflow} brand={savedBrand} />
            {hasCurrentBaseline && <details className="geo-panel geo-evidence-panel">
              <summary>查看基线答案及其引用</summary>
              <GeoAnswerLog answers={workflow.answers.filter(answer => answer.brand === savedBrand)} phase="baseline" />
            </details>}
            <section className="geo-panel" aria-label="信源缺口清单">
              <div className="geo-field-heading"><h3>信源缺口清单</h3>
                {canEditWorkflow && <div className="geo-actions">
                  {modelAvailable && hasCurrentBaseline &&
                    <button type="button" className="button secondary" disabled={busy || gaps.length >= 60} onClick={diagnose}><Sparkles size={16} aria-hidden="true" />AI 建议信源缺口</button>}
                  <button type="button" className="button primary" disabled={busy || !gapsChanged} onClick={saveGaps}>保存缺口清单</button>
                </div>}
              </div>
              {hasCurrentBaseline && modelAvailable && canEditWorkflow && <p className="geo-muted">AI 根据真实基线答案和已有可信来源提出缺口建议，每条建议关联具体答案。核对后可保存。</p>}
              {hasCurrentBaseline && canEditWorkflow && capabilities.status === 'ready' && !modelAvailable &&
                <p className="geo-muted">当前没有可用的诊断模型，可手动登记缺口。</p>}
              {diagnosisSource && <p className="geo-muted">建议生成模型 · {diagnosisSource}</p>}
              <GeoGapEditor gaps={gaps} answers={workflow.answers} disabled={busy || !canEditWorkflow} onChange={setGaps} />
            </section>
          </>}
          {step === 3 && <>
        {generationGaps.length > 0 && <section className="geo-panel" aria-label="按信源缺口补齐">
          <div className="geo-field-heading">
            <h3>按信源缺口补齐</h3>
            {project.canEdit && <button type="button" className="button primary" disabled={busy || !modelAvailable || !readyGuidedBrief} onClick={() => generate(true)}>
              <Sparkles size={16} aria-hidden="true" />按缺口生成稿件
            </button>}
          </div>
          <p className="geo-muted">按优先级处理下列已保存缺口。事实与引用以可信来源的原文摘录为准。</p>
          {!readyBrief && readyGuidedBrief && <p className="geo-muted">还没有核对过的摘录，可以先生成补齐框架。</p>}
          {draft.brief.brand.trim() !== savedBrand && <p className="geo-muted">品牌名称有未保存的更改，请先保存建模并核对缺口。</p>}
          <ul className="geo-gap-targets">{generationGaps.map(gap => <li key={gap.id}>
            <span className="geo-count">{gap.priority}</span><strong>{gap.title}</strong>
          </li>)}</ul>
          <GeoGapSources gaps={generationGaps} answers={workflow.answers} sources={draft.brief.sources} disabled={busy || !project.canEdit}
            onAdd={source => updateDraft({ ...draft, brief: { ...draft.brief, sources: [...draft.brief.sources, source] } })} />
        </section>}
        <div className="geo-columns">
          <section className="geo-panel" aria-label="创作资料">
            <h3>可信来源</h3>
            <SourceEditor key={project.id} brief={draft.brief} editable={project.canEdit} busy={busy}
              onChange={brief => updateDraft({ ...draft, brief })} onRemoveSource={removeSource} />
          </section>
          <section className="geo-panel" aria-label="文章稿件">
            <div className="geo-field-heading">
              <h3>文章稿件</h3>
              {project.canEdit && <button type="button" className="button secondary" disabled={busy || !modelAvailable || !readyBrief} onClick={() => generate()}>
                <Sparkles size={16} aria-hidden="true" />AI 生成稿件
              </button>}
            </div>
            {structure && <p className="geo-muted">结构化数据按已保存的稿件导出。请只保留发布页面上实际可见的问答。</p>}
            {articleSource && <p className="geo-muted">稿件生成模型 · {articleSource}</p>}
            {project.canEdit && capabilities.status === 'ready' && !modelAvailable && <p className="geo-muted">可手动编辑。启用工作台大模型后可以生成稿件。</p>}
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
        <section className="geo-panel" aria-label="复测对照">
          <div className="geo-field-heading"><h3>复测对照</h3>
            {workflow.answers.length > 0 && <button type="button" className="button secondary"
              onClick={() => downloadGeoReport(project.document.brief, workflow)}><Download size={16} aria-hidden="true" />导出诊断报告</button>}
          </div>
          {project.publication ? <>
            <GeoRetestComparison workflow={workflow} brand={savedBrand} />
            {canEditWorkflow && <>
              {aiCaptureControls('retest')}
              <GeoAnswerCapture workflow={workflow} brand={savedBrand} phase="retest"
                draft={captures.retest} disabled={busy} onChange={next => setCaptures(current => ({ ...current, retest: next }))} onSave={recordCapture} />
            </>}
            <GeoAnswerLog answers={workflow.answers} phase="retest" />
          </> : <p className="geo-muted">登记实际发布回执后，按基线的同一问题、引擎和轮次录入复测答案。</p>}
        </section>
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
        </section>
      </>}
    </div>
  </section>;
}
