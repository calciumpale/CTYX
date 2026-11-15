'use client';

import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useId, type FormEvent } from 'react';
import { compareGeoMetrics, computeGeoMetrics, geoSampleKey } from '../lib/geo-metrics';
import {
  GEO_QUESTION_DIMENSIONS, GEO_QUESTION_INTENTS, type GeoAnswer, type GeoAnswerInput, type GeoBrief, type GeoGap,
  type GeoQuestion, type GeoWorkflow, type GeoWorkflowPlan,
} from '../lib/geo-types';

export type GeoPlan = GeoWorkflowPlan;
type Phase = GeoAnswer['phase'];
type Slot = Pick<GeoAnswer, 'questionId' | 'engine' | 'sample'>;
export type CaptureInput = GeoAnswerInput;
export type CaptureDraft = Omit<CaptureInput, 'phase'>;

export function emptyCapture(): CaptureDraft {
  return { id: '', questionId: '', engine: '', sample: 1, rawAnswer: '', citations: [], brandMentions: 0, brandRank: null, competitorMentions: [] };
}

const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });

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

export function GeoPlanEditor({ plan, mainQuestion, disabled, onChange }: {
  plan: GeoPlan;
  mainQuestion: string;
  disabled: boolean;
  onChange: (plan: GeoPlan) => void;
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
        <NamedList label="AI 引擎" values={plan.engines} max={12} suggestions={['DeepSeek', '豆包', 'Kimi', 'ChatGPT', '元宝', '夸克']}
          onChange={engines => onChange({ ...plan, engines })} />
        <label>每个问题在每个引擎重复的次数<select className="select" value={plan.repeats}
          onChange={event => onChange({ ...plan, repeats: Number(event.target.value) })}>
          {[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count} 次</option>)}
        </select></label>
        <NamedList label="竞品" values={plan.competitors} max={20} onChange={competitors => onChange({ ...plan, competitors })} />
        <p className="geo-muted">引擎用于规划人工采样。回答结果需在实际引擎中查询后录入。</p>
      </fieldset>
    </section>
  </div>;
}

function availableSlots(workflow: GeoWorkflow, phase: Phase, brand: string): Slot[] {
  const taken = new Set(workflow.answers.filter(answer => answer.phase === phase).map(geoSampleKey));
  const baseline = new Set(phase === 'retest' ? workflow.answers.filter(answer => answer.phase === 'baseline').map(geoSampleKey) : []);
  return workflow.questions.flatMap(question => workflow.engines.flatMap(engine =>
    Array.from({ length: workflow.repeats }, (_, position) => {
      const slot: Slot = { questionId: question.id, engine, sample: position + 1 };
      const key = geoSampleKey({ ...slot, brand: brand.trim(), prompt: question.prompt, dimension: question.dimension, intent: question.intent });
      return taken.has(key) || (phase === 'retest' && !baseline.has(key)) ? [] : [slot];
    }).flat(),
  ));
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
  if (workflow.answers.length >= 600) return <p className="geo-muted">本项目已达到 600 份答案记录，可新建项目继续采样。</p>;
  if (!slots.length) return <p className="geo-muted">{phase === 'retest'
    ? '暂无可复测的采样位置。保留原有问题、品牌和引擎，并先记录一份同轮次基线答案。'
    : '暂无可用的采样位置。请先保存追踪问题和引擎；已填满的采样位置会显示在答案记录中。'}</p>;
  const questionIds = new Set(slots.map(slot => slot.questionId));
  const questionId = questionIds.has(draft.questionId) ? draft.questionId : slots[0].questionId;
  const questionSlots = slots.filter(slot => slot.questionId === questionId);
  const engines = new Set(questionSlots.map(slot => slot.engine));
  const engine = engines.has(draft.engine) ? draft.engine : questionSlots[0].engine;
  const engineSlots = questionSlots.filter(slot => slot.engine === engine);
  const sample = engineSlots.some(slot => slot.sample === draft.sample) ? draft.sample : engineSlots[0].sample;
  const patch = (changes: Partial<CaptureDraft>) => onChange({ ...draft, ...changes });
  const updateCitation = (index: number, changes: Partial<GeoAnswer['citations'][number]>) =>
    patch({ citations: draft.citations.map((item, position) => position === index ? { ...item, ...changes } : item) });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    onSave({ ...draft, id, questionId, engine, sample, phase, brandRank: draft.brandMentions ? draft.brandRank : null,
      competitorMentions: draft.competitorMentions.filter(item => workflow.competitors.includes(item.name)) });
  }
  return <form className="geo-fields" aria-labelledby={formId} onSubmit={submit}>
    <h4 id={formId}>{phase === 'baseline' ? '人工录入基线答案' : '人工录入复测答案'}</h4>
    <p className="geo-muted">记录实际查询得到的回答原文、推荐位次及引用页面。每一轮使用一份独立答案。</p>
    <fieldset className="geo-fields" disabled={disabled}>
      <legend className="geo-visually-hidden">采样答案详情</legend>
      <label>采样问题<select name="questionId" className="select" value={questionId}
        onChange={event => patch({ questionId: event.target.value, sample: 1 })}>
        {workflow.questions.filter(question => questionIds.has(question.id)).map(question =>
          <option key={question.id} value={question.id}>{question.prompt}</option>)}
      </select></label>
      <div className="geo-field-pair">
        <label>采样引擎<select name="engine" className="select" value={engine}
          onChange={event => patch({ engine: event.target.value, sample: 1 })}>
          {[...engines].map(value => <option key={value}>{value}</option>)}
        </select></label>
        <label>采样轮次<select name="sample" className="select" value={sample} onChange={event => patch({ sample: Number(event.target.value) })}>
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
        <button type="submit" className="button primary">保存答案记录</button>
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
          <span className="geo-answer-title"><strong>{answer.prompt}</strong><small>{answer.engine} · 第 {answer.sample} 次 · {dateTime.format(new Date(answer.recordedAt))}</small></span>
          <span className="geo-count">{answer.brandMentions ? `提及 ${answer.brandMentions} 次` : '未提及'}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        <div className="geo-answer-detail">
          <p className="geo-muted">人工采样{answer.brand ? ` · ${answer.brand}` : ''}{answer.brandRank ? ` · 位次 ${answer.brandRank}` : ''}</p>
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
  const ranks = workflow.answers.filter(answer => answer.phase === 'baseline' && answer.brand === brand && answer.brandRank !== null)
    .reduce<Record<number, number>>((counts, answer) => {
      const rank = answer.brandRank!;
      counts[rank] = (counts[rank] ?? 0) + 1;
      return counts;
    }, {});
  return <section className="geo-panel" aria-label="品牌可见性诊断">
    <div className="geo-field-heading"><h3>品牌可见性诊断</h3><span className="geo-count">基线 · {metrics.samples} 份答案</span></div>
    <dl className="geo-stat-grid">
      <div><dt>品牌提及率</dt><dd>{labelNumber(metrics.mentionRate, '%')}</dd></div>
      <div><dt>首推率</dt><dd>{labelNumber(metrics.firstRecommendationRate, '%')}</dd></div>
      <div><dt>品牌信源引用率</dt><dd>{labelNumber(metrics.citationRate, '%')}</dd></div>
    </dl>
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

export function GeoRetestComparison({ workflow, brand }: { workflow: GeoWorkflow; brand: string }) {
  const { baseline, retest } = compareGeoMetrics(workflow, brand);
  if (!retest.samples) return <p className="geo-muted">完成同一问题、引擎和轮次的复测后，会显示与基线的对照。</p>;
  return <>
    <p className="geo-muted">{retest.samples} 组相同采样位置的实测对照。</p>
    <table className="geo-comparison-table">
      <caption className="geo-visually-hidden">同批样本基线与复测对照</caption>
      <thead><tr><th scope="col">指标</th><th scope="col">基线</th><th scope="col">复测</th></tr></thead>
      <tbody>
        <tr><th scope="row">品牌提及率</th><td>{labelNumber(baseline.mentionRate, '%')}</td><td>{labelNumber(retest.mentionRate, '%')}</td></tr>
        <tr><th scope="row">首推率</th><td>{labelNumber(baseline.firstRecommendationRate, '%')}</td><td>{labelNumber(retest.firstRecommendationRate, '%')}</td></tr>
        <tr><th scope="row">品牌信源引用率</th><td>{labelNumber(baseline.citationRate, '%')}</td><td>{labelNumber(retest.citationRate, '%')}</td></tr>
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
  const title = `${brief.brand || brief.topic || 'GEO'} 信源诊断报告`;
  const content = [
    `# ${reportText(title)}`, '',
    '数据来自项目成员人工录入的实际答案。比率以有效样本数为分母。', '',
    '## 品牌可见性基线', '',
    `- 实际样本：${metrics.samples} 份`,
    `- 品牌提及率：${percent(metrics.mentionRate)}`,
    `- 首推率：${percent(metrics.firstRecommendationRate)}`,
    `- 品牌信源引用率：${percent(metrics.citationRate)}`, '',
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
      `| 首推率 | ${percent(pairs.baseline.firstRecommendationRate)} | ${percent(pairs.retest.firstRecommendationRate)} |`,
      `| 品牌信源引用率 | ${percent(pairs.baseline.citationRate)} | ${percent(pairs.retest.citationRate)} |`,
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
