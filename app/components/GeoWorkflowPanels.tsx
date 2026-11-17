'use client';

import { ChevronDown, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useId, type FormEvent } from 'react';
import { compareGeoMetrics, computeGeoMetrics, geoSampleKey } from '../lib/geo-metrics';
import {
  GEO_QUESTION_DIMENSIONS, GEO_QUESTION_INTENTS, type GeoAnswer, type GeoAnswerInput, type GeoBrief, type GeoGap,
  type GeoQuestion, type GeoSource, type GeoWorkflow, type GeoWorkflowPlan,
} from '../lib/geo-types';

export type GeoPlan = GeoWorkflowPlan;
type Phase = GeoAnswer['phase'];
type Slot = Pick<GeoAnswer, 'questionId' | 'engine' | 'sample'>;
export type GeoSampleSlot = Slot & { sampleKey: string; baseline?: Pick<GeoAnswer, 'method' | 'provenance'> };
export type GeoCaptureProvider = 'apimart' | 'workspace';
export interface GeoCaptureModel { provider: GeoCaptureProvider; model?: string; webSearch?: boolean }
export interface GeoCaptureEngine extends GeoCaptureModel { engine: string; slots?: number }
export const GEO_CAPTURE_PROVIDER_LABELS = { apimart: 'APIMart', workspace: '工作台大模型', manual: '人工采样' } as const;
export type CaptureInput = GeoAnswerInput;
export type CaptureDraft = Omit<CaptureInput, 'phase'> & { sampleKey?: string };

export function emptyCapture(): CaptureDraft {
  return { id: '', questionId: '', engine: '', sample: 1, rawAnswer: '', citations: [], brandMentions: 0, brandRank: null, competitorMentions: [] };
}

export function hasCaptureDraft(value: CaptureDraft) {
  return Boolean(value.rawAnswer.trim() || value.citations.length || value.brandMentions || value.competitorMentions.some(item => item.count));
}

const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });

function methodLabel(answer: GeoAnswer) {
  return GEO_CAPTURE_PROVIDER_LABELS[answer.provenance?.provider ?? answer.method ?? 'manual'];
}

function captureCounts(answers: GeoAnswer[]) {
  const counts = new Map<string, number>();
  for (const answer of answers) {
    const label = methodLabel(answer);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label} ${count} 份`).join(' · ');
}

function labelNumber(value: number | null, suffix = '') {
  return value === null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value) + suffix;
}

function addQuestion(prompt = ''): GeoQuestion {
  return { id: crypto.randomUUID(), dimension: 'category', intent: 'awareness', prompt };
}

function NamedList({ label, values, max, onChange, suggestions = [] }: {
  label: string;
  values: string[];
  max: number;
  onChange: (values: string[]) => void;
  suggestions?: string[];
}) {
  const id = useId();
  return <fieldset className="geo-fields geo-compact-fields">
    <legend>{label}</legend>
    {suggestions.length > 0 && <div className="geo-engine-options">
      {suggestions.map(value => <label key={value} className="geo-checkbox">
        <input type="checkbox" checked={values.includes(value)} disabled={!values.includes(value) && values.length >= max}
          onChange={event => onChange(event.target.checked ? [...values, value] : values.filter(item => item !== value))} />{value}
      </label>)}
    </div>}
    {values.map((value, index) => suggestions.includes(value) ? null : <div className="geo-inline-input" key={index}>
      <label htmlFor={`${id}-${index}`} className="geo-visually-hidden">{label} {index + 1}</label>
      <input id={`${id}-${index}`} className="input" value={value} maxLength={120}
        onChange={event => onChange(values.map((item, position) => position === index ? event.target.value : item))} />
      <button type="button" className="icon-button" aria-label={`移除${label} ${index + 1}`}
        onClick={() => onChange(values.filter((_, position) => position !== index))}><Trash2 size={15} aria-hidden="true" /></button>
    </div>)}
    <div className="geo-actions"><button type="button" className="button ghost" disabled={values.length >= max || values.includes('')}
      onClick={() => onChange([...values, ''])}><Plus size={15} aria-hidden="true" />{suggestions.length ? '添加自定义引擎' : `添加${label}`}</button></div>
  </fieldset>;
}

function GeoCaptureModels({ label, engines }: { label: string; engines: GeoCaptureEngine[] }) {
  if (!engines.length) return null;
  return <ul className="geo-capture-models" aria-label={label}>
    {engines.map(({ engine, provider, model, webSearch, slots }) => <li key={JSON.stringify([engine, provider, model, webSearch])}>
      <strong>{engine}</strong>
      <small>{GEO_CAPTURE_PROVIDER_LABELS[provider]}{model && ` · ${model}`}{webSearch !== undefined && (webSearch ? ' · 联网检索' : ' · 模型直答')}{slots && ` · ${slots} 份`}</small>
    </li>)}
  </ul>;
}

export function GeoPlanEditor({ plan, mainQuestion, disabled, onChange, aiEngines }: {
  plan: GeoPlan;
  mainQuestion: string;
  disabled: boolean;
  onChange: (plan: GeoPlan) => void;
  aiEngines: GeoCaptureEngine[];
}) {
  return <div className="geo-columns geo-plan-columns">
    <section className="geo-panel" aria-label="追踪问题">
      <header className="geo-field-heading"><h3>追踪问题</h3><span className="geo-count">{plan.questions.length} 个</span></header>
      <fieldset className="geo-fields" disabled={disabled}>
        <legend className="geo-visually-hidden">追踪问题清单</legend>
        <p className="geo-muted">按提问维度和用户意图分类，比较模型在不同场景下的实际答案。</p>
        {plan.questions.map((question, index) => {
          const patch = (changes: Partial<GeoQuestion>) => onChange({
            ...plan, questions: plan.questions.map(item => item.id === question.id ? { ...item, ...changes } : item),
          });
          return <fieldset className="geo-fields geo-entry geo-compact-fields" key={question.id}>
            <legend>问题 {index + 1}</legend>
            <label>问题<textarea className="textarea" rows={2} maxLength={600} value={question.prompt}
              onChange={event => patch({ prompt: event.target.value })} /></label>
            <div className="geo-field-pair">
              <label>提问维度<select className="select" value={question.dimension}
                onChange={event => patch({ dimension: event.target.value as GeoQuestion['dimension'] })}>
                {Object.entries(GEO_QUESTION_DIMENSIONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></label>
              <label>用户意图<select className="select" value={question.intent}
                onChange={event => patch({ intent: event.target.value as GeoQuestion['intent'] })}>
                {Object.entries(GEO_QUESTION_INTENTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></label>
            </div>
            <div className="geo-actions"><button type="button" className="button ghost" aria-label={`移除问题 ${index + 1}`}
              onClick={() => onChange({ ...plan, questions: plan.questions.filter(item => item.id !== question.id) })}><Trash2 size={15} aria-hidden="true" />移除问题</button></div>
          </fieldset>;
        })}
        {!disabled && <div className="geo-actions">
          <button type="button" className="button secondary" disabled={plan.questions.length >= 150}
            onClick={() => onChange({ ...plan, questions: [...plan.questions, addQuestion()] })}><Plus size={15} aria-hidden="true" />添加问题</button>
          {mainQuestion.trim() && !plan.questions.some(item => item.prompt.trim() === mainQuestion.trim()) &&
            <button type="button" className="button ghost" disabled={plan.questions.length >= 150}
              onClick={() => onChange({ ...plan, questions: [...plan.questions, addQuestion(mainQuestion.trim())] })}>使用主要问题</button>}
        </div>}
      </fieldset>
    </section>
    <section className="geo-panel" aria-label="采样设置">
      <h3>采样设置</h3>
      <fieldset className="geo-fields" disabled={disabled}>
        <legend className="geo-visually-hidden">采样范围</legend>
        <NamedList label="AI 引擎" values={plan.engines} max={12} suggestions={[...new Set([...aiEngines.map(engine => engine.engine), 'DeepSeek', '豆包', 'Kimi', 'ChatGPT', '元宝', '夸克'])]}
          onChange={engines => onChange({ ...plan, engines })} />
        <label>每个问题在每个引擎重复的次数<select className="select" value={plan.repeats}
          onChange={event => onChange({ ...plan, repeats: Number(event.target.value) })}>
          {[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count} 次</option>)}
        </select></label>
        <NamedList label="竞品" values={plan.competitors} max={20} onChange={competitors => onChange({ ...plan, competitors })} />
        {aiEngines.length ? <GeoCaptureModels label="可自动采样的引擎" engines={aiEngines} />
          : <p className="geo-muted">连接可用的模型后可自动采样，也可在引擎中查询后人工录入。</p>}
      </fieldset>
    </section>
  </div>;
}

export function availableSlots(workflow: GeoWorkflow, phase: Phase, brand: string, method: 'manual' | 'automatic' = 'manual'): GeoSampleSlot[] {
  const taken = new Set(workflow.answers.filter(answer => answer.phase === phase).map(geoSampleKey));
  const baseline = new Map(phase === 'retest' ? workflow.answers
    .filter(answer => answer.phase === 'baseline' && ((answer.method ?? 'manual') === 'manual') === (method === 'manual'))
    .map(answer => [geoSampleKey(answer), { method: answer.method, provenance: answer.provenance }]) : []);
  return workflow.questions.flatMap(question => workflow.engines.flatMap(engine =>
    Array.from({ length: workflow.repeats }, (_, position) => {
      const slot: Slot = { questionId: question.id, engine, sample: position + 1 };
      const key = geoSampleKey({ ...slot, brand: brand.trim(), prompt: question.prompt, dimension: question.dimension, intent: question.intent });
      const source = baseline.get(key);
      return taken.has(key) || (phase === 'retest' && !source) ? [] : [{ ...slot, sampleKey: key, ...(source && { baseline: source }) }];
    }).flat(),
  ));
}

export interface GeoCaptureProgress {
  completed: number;
  total: number;
  message: string;
  engines: GeoCaptureEngine[];
}

export interface GeoCaptureRecovery {
  id: string;
  status: 'running' | 'failed' | 'unknown';
  sampleKey: string;
  message?: string;
}

export function GeoAiCaptureControls({ phase, capabilitiesReady, serviceAvailable, connectionNote, available, batchSize, batch, progress, recovery, disabled, canRetry, active, stopping, manualDraft,
  onStart, onStop, onQuery, onRetry }: {
  phase: Phase;
  capabilitiesReady: boolean;
  serviceAvailable: boolean;
  connectionNote?: string;
  available: number;
  batchSize: number;
  batch: GeoCaptureEngine[];
  progress?: GeoCaptureProgress;
  recovery?: GeoCaptureRecovery;
  disabled: boolean;
  canRetry: boolean;
  active: boolean;
  stopping: boolean;
  manualDraft: boolean;
  onStart: () => void;
  onStop: () => void;
  onQuery: () => void;
  onRetry: () => void;
}) {
  const isRetest = phase === 'retest';
  const action = isRetest ? 'AI 自动复测' : 'AI 自动采样';
  return <div className="geo-ai-sampling">
    <div className="geo-field-heading">
      <h4>{isRetest ? '模型复测' : '模型采样'}</h4>
      <div className="geo-actions">
        {active ? <button type="button" className="button secondary" disabled={stopping} onClick={onStop}>
          {stopping ? '等待本条结束' : '停止本批'}
        </button> : recovery ? <>
          {recovery.status !== 'failed' && <button type="button" className="button secondary" disabled={disabled} onClick={onQuery}>查询上次采样</button>}
          {recovery.status !== 'running' && <button type="button" className="button primary" disabled={disabled || !canRetry} onClick={onRetry}>重新发起采样</button>}
        </> : <button type="button" className="button primary" disabled={disabled || available === 0} onClick={onStart}>
          <Sparkles size={16} aria-hidden="true" />{action}
        </button>}
      </div>
    </div>
    {capabilitiesReady && <p className="geo-muted">{serviceAvailable
      ? available ? `还有 ${available} 个可自动处理的采样位置，每批最多 ${batchSize} 个。模型接口的答案可能与引擎官网显示不同。`
        : isRetest ? '自动复测需要匹配基线的服务、模型与联网设置。暂没有可自动复测的位置。'
          : '已保存计划中没有可自动采样的位置。请检查引擎选择或查看已采样答案。'
      : '当前没有可用的自动采样连接。可使用下方的人工录入。'}</p>}
    {connectionNote && <p className="geo-muted">{connectionNote}</p>}
    <GeoCaptureModels label={active ? '本批使用的模型' : '下一批预计使用的模型'}
      engines={active ? progress?.engines ?? [] : batch} />
    {manualDraft && <p className="geo-muted">保存或清空下方人工录入草稿后，可开始自动采样。</p>}
    {recovery && !active && <p className="geo-muted">{
      recovery.message || (recovery.status === 'failed' ? '上次采样未能保存。' : '上次采样结果仍待确认。')
    }{recovery.status === 'unknown' ? ' 查询保留原请求，重新发起可能产生新的调用费用。' : ''}</p>}
    <div className="geo-capture-progress">
      {progress && <progress aria-label={`${action}进度`} max={progress.total} value={progress.completed} />}
      <p role="status" className="geo-muted">{progress?.message}</p>
    </div>
  </div>;
}

export function GeoAnswerCapture({ workflow, brand, phase, draft, onChange, onSave, disabled }: {
  workflow: GeoWorkflow;
  brand: string;
  phase: Phase;
  draft: CaptureDraft;
  onChange: (draft: CaptureDraft) => void;
  onSave: (answer: CaptureInput) => void;
  disabled: boolean;
}) {
  const formId = useId();
  const slots = availableSlots(workflow, phase, brand);
  const hasDraft = hasCaptureDraft(draft);
  const clear = hasDraft && <button type="button" className="button ghost" disabled={disabled}
    onClick={() => onChange(emptyCapture())}>清空录入草稿</button>;
  if (workflow.answers.length >= 600) return <p className="geo-muted">本项目已达到 600 份答案记录，可新建项目继续采样。</p>;
  if (!slots.length) return <div className="geo-actions"><p className="geo-muted">{phase === 'retest'
    ? '暂无可人工录入的复测位置。人工复测需要同一问题、引擎与轮次的人工基线答案。'
    : '暂无可用的采样位置。请先保存追踪问题和引擎；已填满的采样位置会显示在答案记录中。'}</p>{clear}</div>;
  const questionIds = new Set(slots.map(slot => slot.questionId));
  const questionId = questionIds.has(draft.questionId) ? draft.questionId : slots[0].questionId;
  const questionSlots = slots.filter(slot => slot.questionId === questionId);
  const engines = new Set(questionSlots.map(slot => slot.engine));
  const engine = engines.has(draft.engine) ? draft.engine : questionSlots[0].engine;
  const engineSlots = questionSlots.filter(slot => slot.engine === engine);
  const selection = engineSlots.find(slot => slot.sample === draft.sample) ?? engineSlots[0];
  const moved = hasDraft && selection.sampleKey !== draft.sampleKey;
  const patch = (changes: Partial<CaptureDraft>) => onChange({ ...draft, ...(hasDraft ? {} : selection), ...changes });
  const updateCitation = (index: number, changes: Partial<GeoAnswer['citations'][number]>) =>
    patch({ citations: draft.citations.map((item, position) => position === index ? { ...item, ...changes } : item) });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (moved) return;
    if (!draft.rawAnswer.trim()) {
      const field = event.currentTarget.elements.namedItem('rawAnswer');
      if (field instanceof HTMLTextAreaElement) {
        field.setCustomValidity('请粘贴实际答案原文。');
        field.reportValidity();
      }
      return;
    }
    const id = draft.id || crypto.randomUUID();
    patch({ id });
    onSave({ id, questionId, engine, sample: selection.sample, phase, rawAnswer: draft.rawAnswer, citations: draft.citations,
      brandMentions: draft.brandMentions, brandRank: draft.brandMentions ? draft.brandRank : null,
      competitorMentions: draft.competitorMentions.filter(item => workflow.competitors.includes(item.name)) });
  }
  return <form className="geo-fields" aria-labelledby={formId} onSubmit={submit}>
    <h4 id={formId}>{phase === 'baseline' ? '人工录入基线答案' : '人工录入复测答案'}</h4>
    <p className="geo-muted">记录实际查询得到的回答原文、推荐位次及引用页面。每一轮使用一份独立答案。</p>
    <fieldset className="geo-fields" disabled={disabled}>
      <legend className="geo-visually-hidden">采样答案详情</legend>
      {moved && <div className="geo-notice">
        这份草稿原来对应的采样位置已变化。核对当前问题、引擎和轮次后再提交。
        <button type="button" className="button secondary" onClick={() => patch(selection)}>使用当前采样位置</button>
      </div>}
      <label>采样问题<select name="questionId" className="select" value={questionId}
        onChange={event => {
          const next = slots.find(slot => slot.questionId === event.target.value && slot.engine === engine) ??
            slots.find(slot => slot.questionId === event.target.value);
          if (next) patch(next);
        }}>
        {workflow.questions.filter(question => questionIds.has(question.id)).map(question =>
          <option key={question.id} value={question.id}>{question.prompt}</option>)}
      </select></label>
      <div className="geo-field-pair">
        <label>采样引擎<select name="engine" className="select" value={engine}
          onChange={event => {
            const next = questionSlots.find(slot => slot.engine === event.target.value);
            if (next) patch(next);
          }}>
          {[...engines].map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>采样轮次<select name="sample" className="select" value={selection.sample} onChange={event => {
          const next = engineSlots.find(slot => slot.sample === Number(event.target.value));
          if (next) patch(next);
        }}>
          {engineSlots.map(slot => <option key={slot.sample} value={slot.sample}>第 {slot.sample} 次</option>)}
        </select></label>
      </div>
      <label>答案原文<textarea name="rawAnswer" className="textarea" rows={5} required maxLength={12000} value={draft.rawAnswer}
        onChange={event => { event.currentTarget.setCustomValidity(''); patch({ rawAnswer: event.target.value }); }} /></label>
      <div className="geo-field-pair">
        <label>品牌提及次数<input name="brandMentions" className="input" type="number" min={0} max={999} required value={draft.brandMentions}
          onChange={event => patch({ brandMentions: Number(event.target.value) })} /></label>
        <label>品牌首次位次<input name="brandRank" className="input" type="number" min={1} max={999} disabled={!draft.brandMentions}
          placeholder="没有明确排名时留空" value={draft.brandRank ?? ''} onChange={event => patch({ brandRank: event.target.value ? Number(event.target.value) : null })} /></label>
      </div>
      {workflow.competitors.length > 0 && <fieldset className="geo-fields geo-compact-fields">
        <legend>竞品提及次数</legend>
        <div className="geo-field-pair">{workflow.competitors.map(name => <label key={name}>{name}
          <input className="input" type="number" min={0} max={999} value={draft.competitorMentions.find(item => item.name === name)?.count ?? 0}
            onChange={event => patch({ competitorMentions: [...draft.competitorMentions.filter(item => item.name !== name), { name, count: Number(event.target.value) }] })} />
        </label>)}</div>
      </fieldset>}
      {draft.citations.map((citation, index) => <fieldset key={index} className="geo-entry geo-fields geo-compact-fields">
        <legend>答案引用 {index + 1}</legend>
        <label>页面标题（选填）<input className="input" maxLength={200} value={citation.title}
          onChange={event => updateCitation(index, { title: event.target.value })} /></label>
        <label>引用链接<input className="input" type="url" pattern="https://.+" placeholder="https://" required maxLength={2048} value={citation.url}
          onChange={event => updateCitation(index, { url: event.target.value })} /></label>
        <div className="geo-field-heading">
          <label className="geo-checkbox"><input type="checkbox" checked={citation.brandSource}
            onChange={event => updateCitation(index, { brandSource: event.target.checked })} />目标品牌信源</label>
          <button type="button" className="icon-button" aria-label={`移除答案引用 ${index + 1}`}
            onClick={() => patch({ citations: draft.citations.filter((_, position) => index !== position) })}><Trash2 size={15} aria-hidden="true" /></button>
        </div>
      </fieldset>)}
      <div className="geo-actions">
        <button type="button" className="button ghost" disabled={draft.citations.length >= 20}
          onClick={() => patch({ citations: [...draft.citations, { title: '', url: '', brandSource: false }] })}><Plus size={15} aria-hidden="true" />添加答案引用</button>
        {clear}
        <button type="submit" className="button primary" disabled={moved}>保存答案记录</button>
      </div>
    </fieldset>
  </form>;
}

export function GeoAnswerLog({ answers, phase }: { answers: GeoAnswer[]; phase: Phase }) {
  const filtered = answers.filter(answer => answer.phase === phase);
  if (!filtered.length) return <p className="geo-muted">{phase === 'baseline' ? '暂无基线答案记录。' : '暂无复测答案记录。'}</p>;
  return <ul className="geo-answer-log">
    {filtered.map(answer => <li key={answer.id}>
      <details>
        <summary>
          <span className="geo-answer-title"><strong>{answer.prompt}</strong><small>{answer.engine} · {methodLabel(answer)} · 第 {answer.sample} 次 · {dateTime.format(new Date(answer.recordedAt))}</small></span>
          <span className="geo-count">{answer.brandMentions ? `提及 ${answer.brandMentions} 次` : '未提及'}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <div className="geo-answer-detail">
          <p className="geo-muted">{methodLabel(answer)}{answer.method !== 'manual' && answer.provenance &&
            ` 模型接口 · ${answer.provenance.model}${answer.provenance.webSearch ? ' · 已启用检索' : ' · 未启用检索'}${answer.provenance.annotations === 'provider' ? ' · 接口返回引用' : ' · 接口未提供引用信息'}`}
            {answer.brand ? ` · ${answer.brand}` : ''}{answer.brandRank ? ` · 位次 ${answer.brandRank}` : ''}</p>
          <p>{answer.rawAnswer}</p>
          {answer.citations.length > 0 && <ul className="geo-citations">
            {answer.citations.map((item, index) => <li key={index}>
              {/^https:\/\//i.test(item.url) ? <a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a> : item.title}
              {item.brandSource && <span className="geo-count">品牌信源</span>}
            </li>)}
          </ul>}
          {answer.competitorMentions.length > 0 && <p className="geo-muted">竞品提及 {answer.competitorMentions.map(item => `${item.name} ${item.count} 次`).join('、')}</p>}
        </div>
      </details>
    </li>)}
  </ul>;
}

export function GeoVisibility({ workflow, brand }: { workflow: GeoWorkflow; brand: string }) {
  const metrics = computeGeoMetrics(workflow, 'baseline', brand);
  const baseline = workflow.answers.filter(answer => answer.phase === 'baseline' && answer.brand === brand);
  const ranks = baseline.filter(answer => answer.brandRank !== null)
    .reduce<Record<number, number>>((counts, answer) => {
      const rank = answer.brandRank!;
      counts[rank] = (counts[rank] ?? 0) + 1;
      return counts;
    }, {});
  return <section className="geo-panel" aria-label="品牌可见性诊断">
    <div className="geo-field-heading"><h3>品牌可见性诊断</h3><span className="geo-count">基线 · {metrics.samples} 份答案</span></div>
    <dl className="geo-stat-grid">
      <div><dt>品牌提及率</dt><dd>{labelNumber(metrics.mentionRate, '%')}</dd></div>
      <div><dt>首推率</dt><dd>{labelNumber(metrics.firstRecommendationRate, '%')}</dd>
        {metrics.firstRecommendationSamples < metrics.samples && <small className="geo-metric-detail">{metrics.firstRecommendationSamples} 份可判定</small>}</div>
      <div><dt>品牌信源引用率</dt><dd>{labelNumber(metrics.citationRate, '%')}</dd>
        {metrics.citationSamples < metrics.samples && <small className="geo-metric-detail">{metrics.citationSamples} 份可核对</small>}</div>
    </dl>
    {baseline.some(answer => answer.method !== 'manual') && <p className="geo-muted">{captureCounts(baseline)}。接口缺失的排名和引用信息不计入对应指标。</p>}
    {!metrics.samples ? <p className="geo-muted">记录基线答案后显示诊断。每项比率按实际录入的样本计算。</p> : <>
      <div className="geo-field-pair">
        <section className="geo-stat-breakdown"><h4>按引擎</h4>
          <ul>{Object.entries(metrics.byEngine).map(([name, result]) => <li key={name}><span>{name}</span><strong>{result.samples} 份 · {labelNumber(result.mentionRate, '%')} 提及</strong></li>)}</ul>
        </section>
        <section className="geo-stat-breakdown"><h4>意图分层覆盖</h4>
          <ul>{Object.entries(metrics.byIntent).map(([name, result]) => <li key={name}><span>{GEO_QUESTION_INTENTS[name as keyof typeof GEO_QUESTION_INTENTS] ?? name}</span><strong>{result.samples} 份 · {labelNumber(result.mentionRate, '%')} 提及</strong></li>)}</ul>
        </section>
      </div>
      <section className="geo-stat-breakdown"><h4>提及位次分布</h4>
        {Object.keys(ranks).length ? <ul>{Object.entries(ranks).map(([rank, count]) => <li key={rank}><span>第 {rank} 位</span><strong>{count} 份</strong></li>)}</ul>
          : <p className="geo-muted">当前基线答案没有标注位次。</p>}
      </section>
    </>}
  </section>;
}

function GapEvidence({ selected, answers, onChange }: { selected: string[]; answers: GeoAnswer[]; onChange: (ids: string[]) => void }) {
  return <div className="geo-fields">
    <label>关联答案证据<select className="select" value="" disabled={selected.length >= 20}
      onChange={event => { if (event.target.value) onChange([...selected, event.target.value]); }}>
      <option value="" disabled>选择要关联的答案</option>
      {answers.filter(answer => !selected.includes(answer.id)).map(answer =>
        <option value={answer.id} key={answer.id}>{answer.engine} · 第 {answer.sample} 次 · {answer.prompt}</option>)}
    </select></label>
    {selected.length > 0 && <ul className="geo-gap-evidence">{selected.map(id => {
      const answer = answers.find(item => item.id === id);
      return <li key={id}><span>{answer ? `${answer.engine} · ${answer.prompt}` : '答案记录'}</span>
        <button type="button" className="icon-button" aria-label={`移除证据 ${answer?.prompt ?? id}`}
          onClick={() => onChange(selected.filter(value => value !== id))}><Trash2 size={15} aria-hidden="true" /></button>
      </li>;
    })}</ul>}
  </div>;
}

export function GeoGapEditor({ gaps, answers, disabled, onChange }: {
  gaps: GeoGap[]; answers: GeoAnswer[]; disabled: boolean; onChange: (gaps: GeoGap[]) => void;
}) {
  return <fieldset className="geo-fields" disabled={disabled}>
    <legend className="geo-visually-hidden">缺口及补齐计划</legend>
    {!gaps.length && <p className="geo-muted">{answers.length
      ? '对比答案中的引用与现有资料，记录待补齐的信源。'
      : '先在答案级抓取中录入答案，再用实际证据记录信源缺口。'}</p>}
    {gaps.map((gap, index) => {
      const patch = (changes: Partial<GeoGap>) => onChange(gaps.map(item => item.id === gap.id ? { ...item, ...changes } : item));
      return <fieldset key={gap.id} className="geo-fields geo-entry geo-compact-fields">
        <legend>缺口 {index + 1}</legend>
        <label>缺口标题<input className="input" maxLength={200} value={gap.title} onChange={event => patch({ title: event.target.value })} /></label>
        <div className="geo-field-pair">
          <label>优先级<select className="select" value={gap.priority} onChange={event => patch({ priority: event.target.value as GeoGap['priority'] })}>
            <option value="P0">P0 · 优先处理</option><option value="P1">P1 · 计划补齐</option><option value="P2">P2 · 持续观察</option>
          </select></label>
          <label>处理状态<select className="select" value={gap.status} onChange={event => patch({ status: event.target.value as GeoGap['status'] })}>
            <option value="open">待补齐</option><option value="done">已补齐</option>
          </select></label>
        </div>
        <GapEvidence selected={gap.evidenceAnswerIds} answers={answers} onChange={evidenceAnswerIds => patch({ evidenceAnswerIds })} />
        <label>补齐建议<textarea className="textarea" rows={2} maxLength={1500} value={gap.action} onChange={event => patch({ action: event.target.value })} /></label>
        <label>预期影响<textarea className="textarea" rows={2} maxLength={800} value={gap.expectedImpact} onChange={event => patch({ expectedImpact: event.target.value })} /></label>
        {!disabled && <div className="geo-actions"><button type="button" className="button ghost" aria-label={`移除缺口 ${index + 1}`}
          onClick={() => onChange(gaps.filter(item => item.id !== gap.id))}><Trash2 size={15} aria-hidden="true" />移除缺口</button></div>}
      </fieldset>;
    })}
    {!disabled && <div className="geo-actions"><button type="button" className="button secondary" disabled={!answers.length || gaps.length >= 60}
      onClick={() => onChange([...gaps, { id: crypto.randomUUID(), priority: 'P1', title: '', evidenceAnswerIds: [], action: '', expectedImpact: '', status: 'open' }])}>
      <Plus size={15} aria-hidden="true" />添加缺口</button></div>}
  </fieldset>;
}

export function GeoGapSources({ gaps, answers, sources, disabled, onAdd }: {
  gaps: GeoGap[];
  answers: GeoAnswer[];
  sources: GeoSource[];
  disabled: boolean;
  onAdd: (source: GeoSource) => void;
}) {
  const evidenceIds = new Set(gaps.flatMap(gap => gap.evidenceAnswerIds));
  const existingUrls = new Set(sources.map(source => source.url));
  const candidates = new Map<string, { source: GeoSource; provenance: string }>();
  for (const answer of answers) {
    if (!evidenceIds.has(answer.id)) continue;
    for (const citation of answer.citations) {
      try {
        const url = new URL(citation.url);
        if (url.protocol !== 'https:' || url.username || url.password || existingUrls.has(url.href) || candidates.has(url.href)) continue;
        candidates.set(url.href, {
          source: { title: (citation.title || url.hostname).slice(0, 160), url: url.href, excerpt: '' },
          provenance: `${methodLabel(answer)} · ${answer.provenance?.model || answer.engine}`,
        });
      } catch { /* Ignore invalid legacy citation URLs. */ }
    }
  }
  if (!candidates.size) return null;
  return <details className="geo-gap-sources">
    <summary>答案中的候选来源（{candidates.size}）</summary>
    <p className="geo-muted">这些链接来自缺口关联的答案。添加后，请打开原页面核对，并填写可引用的原文摘录。</p>
    <ul className="geo-gap-evidence">
      {[...candidates.values()].slice(0, 12).map(({ source, provenance }) => <li key={source.url}>
        <div><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><small>{provenance}</small></div>
        <button type="button" className="button ghost" disabled={disabled || sources.length >= 8}
          aria-label={`添加候选来源 ${source.title}`} onClick={() => onAdd(source)}><Plus size={15} aria-hidden="true" />添加</button>
      </li>)}
    </ul>
  </details>;
}

export function GeoRetestComparison({ workflow, brand }: { workflow: GeoWorkflow; brand: string }) {
  const { baseline, retest } = compareGeoMetrics(workflow, brand);
  if (!retest.samples) return <p className="geo-muted">完成同一问题、引擎和轮次的复测后，会显示与基线的对照。</p>;
  return <>
    <p className="geo-muted">{retest.samples} 组同问题、同引擎、同采样方式的实测对照。</p>
    <table className="geo-comparison-table">
      <caption className="geo-visually-hidden">同批样本基线与复测对照</caption>
      <thead><tr><th scope="col">指标</th><th scope="col">基线</th><th scope="col">复测</th></tr></thead>
      <tbody>
        <tr><th scope="row">品牌提及率</th><td>{labelNumber(baseline.mentionRate, '%')}</td><td>{labelNumber(retest.mentionRate, '%')}</td></tr>
        <tr><th scope="row">首推率</th>
          <td>{labelNumber(baseline.firstRecommendationRate, '%')}{baseline.firstRecommendationSamples < baseline.samples &&
            <small className="geo-metric-detail">{baseline.firstRecommendationSamples} 份可判定</small>}</td>
          <td>{labelNumber(retest.firstRecommendationRate, '%')}{retest.firstRecommendationSamples < retest.samples &&
            <small className="geo-metric-detail">{retest.firstRecommendationSamples} 份可判定</small>}</td></tr>
        <tr><th scope="row">品牌信源引用率</th>
          <td>{labelNumber(baseline.citationRate, '%')}{baseline.citationSamples < baseline.samples &&
            <small className="geo-metric-detail">{baseline.citationSamples} 份可核对</small>}</td>
          <td>{labelNumber(retest.citationRate, '%')}{retest.citationSamples < retest.samples &&
            <small className="geo-metric-detail">{retest.citationSamples} 份可核对</small>}</td></tr>
      </tbody>
    </table>
  </>;
}

function reportText(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim().replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!)
    .replace(/[\\`*_{}\[\]()#+.!|]/g, '\\$&');
}

export function downloadGeoReport(brief: GeoBrief, workflow: GeoWorkflow) {
  const metrics = computeGeoMetrics(workflow, 'baseline', brief.brand);
  const pairs = compareGeoMetrics(workflow, brief.brand);
  const percent = (value: number | null) => labelNumber(value, '%');
  const rows = (scope: Record<string, ReturnType<typeof computeGeoMetrics>['byEngine'][string]>, format: (key: string) => string) =>
    Object.entries(scope).map(([key, data]) => `- ${reportText(format(key))}：${data.samples} 份，品牌提及 ${percent(data.mentionRate)}，首推 ${percent(data.firstRecommendationRate)}，品牌信源引用 ${percent(data.citationRate)}。`);
  const byAnswerId = new Map(workflow.answers.map(answer => [answer.id, answer]));
  const baselineAnswers = workflow.answers.filter(answer => answer.brand === brief.brand && answer.phase === 'baseline');
  const title = `${brief.brand || brief.topic || 'GEO'} 信源诊断报告`;
  const content = [
    `# ${reportText(title)}`, '',
    '样本来自人工记录与模型接口调用。接口结果可能与引擎官网显示不同。比率以可核验的样本为分母。', '',
    '## 品牌可见性基线', '',
    `- 实际样本：${metrics.samples} 份`,
    ...(baselineAnswers.length ? [`- 采样来源：${captureCounts(baselineAnswers)}`] : []),
    `- 品牌提及率：${percent(metrics.mentionRate)}`,
    `- 首推率：${percent(metrics.firstRecommendationRate)}（${metrics.firstRecommendationSamples} 份可判定）`,
    `- 品牌信源引用率：${percent(metrics.citationRate)}（${metrics.citationSamples} 份可核对）`, '',
    '### 按引擎', '', ...rows(metrics.byEngine, key => key), '',
    '### 按意图', '', ...rows(metrics.byIntent, key => GEO_QUESTION_INTENTS[key as keyof typeof GEO_QUESTION_INTENTS] ?? key), '',
    '## 信源缺口清单', '',
    ...(workflow.gaps.length ? workflow.gaps.flatMap(gap => [
      `### ${gap.priority} · ${reportText(gap.title)}`, '',
      `- 状态：${gap.status === 'done' ? '已补齐' : '待补齐'}`,
      `- 补齐建议：${reportText(gap.action)}`,
      ...(gap.expectedImpact ? [`- 预期影响：${reportText(gap.expectedImpact)}`] : []),
      ...gap.evidenceAnswerIds.flatMap(id => {
        const answer = byAnswerId.get(id);
        return answer ? [`- 答案证据：${reportText(answer.engine)} · 第 ${answer.sample} 次 · ${reportText(answer.prompt)}`] : [];
      }), '',
    ]) : ['暂无已保存的缺口。', '']),
    '## 同批复测对照', '',
    ...(pairs.samples ? [`${pairs.samples} 组相同问题、引擎与轮次的实际样本。`, '',
      '| 指标 | 基线 | 复测 |', '| --- | --- | --- |',
      `| 品牌提及率 | ${percent(pairs.baseline.mentionRate)} | ${percent(pairs.retest.mentionRate)} |`,
      `| 首推率 | ${percent(pairs.baseline.firstRecommendationRate)}（${pairs.baseline.firstRecommendationSamples} 份） | ${percent(pairs.retest.firstRecommendationRate)}（${pairs.retest.firstRecommendationSamples} 份） |`,
      `| 品牌信源引用率 | ${percent(pairs.baseline.citationRate)}（${pairs.baseline.citationSamples} 份） | ${percent(pairs.retest.citationRate)}（${pairs.retest.citationSamples} 份） |`,
    ] : ['暂无与基线匹配的复测样本。']), '',
  ].join('\n');
  downloadGeoFile(title, 'md', 'text/markdown', content);
}

export function downloadGeoFile(title: string, extension: 'json' | 'md', mime: string, content: string) {
  const href = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = href;
  link.download = `${title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 70) || 'GEO'}.${extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
