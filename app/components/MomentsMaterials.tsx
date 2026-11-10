'use client';
/* Saved images are served by authenticated download routes. */
/* eslint-disable @next/next/no-img-element */
import {useCallback, useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {MOMENT_STYLES, type MomentDraft, type MomentPlan, type MomentPlanInput, type MomentSnapshot} from '../lib/moments-types';
import './marketing-materials.css';

type MomentsProps = {
  active: boolean;
  notify: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
};
type MomentAction =
  | {action: 'save'; plan: MomentPlanInput & {id?: string; version?: number}}
  | {action: 'generate'; planId: string; requestId: string}
  | {action: 'delete'; planId: string; version: number}
  | {action: 'refresh'; draftId: string};
type MomentResponse = MomentSnapshot & {planId?: string; draftId?: string};

const DEFAULT_PLAN: MomentPlanInput = {
  productName: '', productDetails: '', style: 'business', time: '09:00', enabled: false, includeImage: true,
};
const DRAFT_STATUS: Record<MomentDraft['status'], string> = {
  queued: '等待生成', writing: '正在写文案', image_pending: '正在生成配图',
  completed: '已完成', partial: '已完成文案 · 配图未完成', failed: '生成失败',
};
const unfinished = (draft: MomentDraft) => ['queued', 'writing', 'image_pending'].includes(draft.status);
const dateTime = new Intl.DateTimeFormat('zh-CN', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai'});

function planInput(plan: MomentPlan): MomentPlanInput {
  const {productName, productDetails, style, time, enabled, includeImage} = plan;
  return {productName, productDetails, style, time, enabled, includeImage};
}

async function request(action?: MomentAction): Promise<MomentResponse> {
  const response = await fetch('/api/moments-materials', action ? {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(action),
  } : {cache: 'no-store'});
  const data = await response.json().catch(() => null) as (MomentResponse & {message?: string}) | null;
  if (!response.ok) throw new Error(data?.message || '朋友圈草稿服务暂时不可用，请稍后重试。');
  if (!data || !Array.isArray(data.plans) || !Array.isArray(data.drafts) || !data.availability) {
    throw new Error('未能读取朋友圈计划和草稿，请刷新列表。');
  }
  return data;
}

export default function MomentsMaterials({active, notify, onBusyChange, onDirtyChange}: MomentsProps) {
  const id = useId();
  const [snapshot, setSnapshot] = useState<MomentResponse>();
  const [editing, setEditing] = useState<MomentPlan>();
  const [form, setForm] = useState<MomentPlanInput>(DEFAULT_PLAN);
  const [selectedDraftId, setSelectedDraftId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const actionInFlight = useRef(false);
  const backgroundInFlight = useRef(false);
  const sequence = useRef(0);
  const preview = useRef<HTMLElement>(null);
  const refreshAttempts = useRef(new Map<string, number>());
  const requestIds = useRef(new Map<string, string>());
  const dirty = JSON.stringify(form) !== JSON.stringify(editing ? planInput(editing) : DEFAULT_PLAN);
  const selectedDraft = snapshot?.drafts.find(draft => draft.id === selectedDraftId) ?? snapshot?.drafts[0];

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const update = useCallback(async (action?: MomentAction, kind: 'manual' | 'load' | 'background' = 'manual') => {
    if (actionInFlight.current || (kind !== 'manual' && backgroundInFlight.current)) return;
    const manual = kind === 'manual';
    if (manual) { actionInFlight.current = true; setBusy(true); }
    else backgroundInFlight.current = true;
    if (kind !== 'background') setError('');
    const current = ++sequence.current;
    try {
      const data = await request(action);
      if (!mounted.current || sequence.current !== current) return;
      setSnapshot(data);
      return data;
    } catch (cause) {
      if (mounted.current && sequence.current === current && kind !== 'background') {
        setError(cause instanceof Error ? cause.message : '操作未完成，请稍后重试。');
      }
    } finally {
      if (manual) actionInFlight.current = false;
      else backgroundInFlight.current = false;
      if (mounted.current && sequence.current === current) setLoading(false);
      if (mounted.current && manual) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => void update(undefined, 'load'), 0);
    return () => clearTimeout(timer);
  }, [active, update]);

  useEffect(() => {
    if (!active || !snapshot) return;
    let idleTicks = 0;
    const timer = setInterval(() => {
      if (actionInFlight.current || backgroundInFlight.current) return;
      const attempts = (draft: MomentDraft) => refreshAttempts.current.get(draft.id) ?? 0;
      const pending = snapshot.drafts.filter(unfinished).sort((left, right) => attempts(left) - attempts(right))[0];
      if (pending && attempts(pending) < 120) {
        refreshAttempts.current.set(pending.id, attempts(pending) + 1);
        void update({action: 'refresh', draftId: pending.id}, 'background');
      } else if (++idleTicks >= 6) {
        idleTicks = 0;
        void update(undefined, 'background');
      }
    }, 6000);
    return () => clearInterval(timer);
  }, [active, snapshot, update]);

  function editPlan(plan?: MomentPlan) {
    if (actionInFlight.current || editing?.id === plan?.id && plan) return;
    if (dirty && !window.confirm('放弃当前计划未保存的修改？')) return;
    setEditing(plan);
    setForm(plan ? planInput(plan) : DEFAULT_PLAN);
    setError('');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionInFlight.current) return;
    const values = {...form, productName: form.productName.trim(), productDetails: form.productDetails.trim()};
    if (!values.productName || !values.productDetails) return;
    const existingIds = new Set(snapshot?.plans.map(plan => plan.id));
    const saved = await update({action: 'save', plan: {...values, ...(editing ? {id: editing.id, version: editing.version} : {})}});
    if (!saved) return;
    const plan = saved.plans.find(item => item.id === (saved.planId ?? editing?.id))
      ?? saved.plans.find(item => !existingIds.has(item.id) && JSON.stringify(planInput(item)) === JSON.stringify(values));
    if (plan) { setEditing(plan); setForm(planInput(plan)); }
    else { setEditing(undefined); setForm(DEFAULT_PLAN); }
    notify('朋友圈计划已保存');
  }

  async function generate(plan: MomentPlan) {
    if (actionInFlight.current) return;
    const key = `${plan.id}:${plan.version}`;
    const requestId = requestIds.current.get(key) ?? crypto.randomUUID();
    requestIds.current.set(key, requestId);
    const existingIds = new Set(snapshot?.drafts.map(draft => draft.id));
    const result = await update({action: 'generate', planId: plan.id, requestId});
    if (!result) return;
    requestIds.current.delete(key);
    const created = result.drafts.find(draft => draft.id === result.draftId)
      ?? result.drafts.find(draft => draft.planId === plan.id && !existingIds.has(draft.id));
    if (created) {
      setSelectedDraftId(created.id);
      if (window.matchMedia('(max-width: 760px)').matches) {
        requestAnimationFrame(() => preview.current?.scrollIntoView({block: 'nearest'}));
      }
    }
    if (!created || unfinished(created)) notify('草稿生成任务已提交');
    else if (created.text) notify('朋友圈文案已生成');
  }

  async function deletePlan(plan: MomentPlan) {
    if (actionInFlight.current || !window.confirm(`删除「${plan.productName}」的计划？已有草稿会保留。`)) return;
    const result = await update({action: 'delete', planId: plan.id, version: plan.version});
    if (!result) return;
    setEditing(undefined);
    setForm(DEFAULT_PLAN);
    notify('计划已删除');
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('朋友圈文案已复制');
    } catch {
      notify('浏览器未允许复制，请选中文案手动复制。');
    }
  }

  const patch = (values: Partial<MomentPlanInput>) => setForm(previous => ({...previous, ...values}));
  const invalid = !form.productName.trim() || !form.productDetails.trim() || !form.time;
  const scheduleUnavailable = form.enabled && snapshot && (!snapshot.availability.text || form.includeImage && !snapshot.availability.image);
  const checkboxStyle = {width: 'auto', minHeight: 'auto', flexShrink: 0};
  const toggleStyle = {flexDirection: 'row', alignItems: 'center', minHeight: 44, marginBottom: 4} as const;

  return <div className="material-generation" aria-label="AI朋友圈">
    <div className="material-generation-heading">
      <p style={{margin: 0}}>为产品生成朋友圈文案和配图。草稿由你检查后手动发布。</p>
      <button type="button" disabled={loading || busy} onClick={() => void update()}>刷新计划与草稿</button>
    </div>
    {error && <p className="material-error" role="alert">{error}</p>}
    {snapshot && !snapshot.availability.text && <p role="status">请在服务连接中启用大模型，以生成朋友圈文案。</p>}
    <div className="material-columns">
      <section className="material-form" aria-labelledby={`${id}-plan-title`}>
        <h3 id={`${id}-plan-title`}>{editing ? '编辑生成计划' : '新建生成计划'}</h3>
        <form onSubmit={event => void save(event)}>
          <label>产品名称
            <input value={form.productName} required maxLength={120} disabled={busy} placeholder="例如：团队协作管理软件" onChange={event => patch({productName: event.target.value})}/>
          </label>
          <label>产品详情
            <textarea value={form.productDetails} required maxLength={2000} disabled={busy} placeholder="写下产品卖点、面向人群或使用场景" onChange={event => patch({productDetails: event.target.value})}/>
          </label>
          <div className="material-options">
            <label>文案风格
              <select aria-label="文案风格" value={form.style} disabled={busy} onChange={event => patch({style: event.target.value as MomentPlanInput['style']})}>
                {Object.entries(MOMENT_STYLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>每天生成时间（北京时间）
              <input type="time" required value={form.time} disabled={busy} onChange={event => patch({time: event.target.value})}/>
            </label>
          </div>
          <label style={toggleStyle}>
            <input type="checkbox" style={checkboxStyle} checked={form.includeImage} disabled={busy} onChange={event => patch({includeImage: event.target.checked})}/>同时生成配图
          </label>
          {form.includeImage && snapshot && !snapshot.availability.image && <p>配图服务尚未启用。取消勾选配图可生成纯文案。</p>}
          <label style={toggleStyle}>
            <input type="checkbox" style={checkboxStyle} checked={form.enabled} disabled={busy} onChange={event => patch({enabled: event.target.checked})}/>每天定时生成草稿
          </label>
          {form.enabled && <p>{scheduleUnavailable ? '启用定时生成前，请先配置所需的模型服务。' : '后台每小时检查一次到期计划，实际开始可能比设定时间晚约一小时。'}</p>}
          <div className="material-options" style={{alignItems: 'baseline'}}>
            <button type="submit" className="material-primary" disabled={busy || loading || invalid || !dirty || scheduleUnavailable}>保存计划</button>
            {editing && <button type="button" disabled={busy || dirty || !snapshot?.availability.text} onClick={() => void generate(editing)}>立即生成草稿</button>}
          </div>
          {editing && dirty && <p>保存修改后可以按新设置生成。</p>}
          {editing && <div className="material-options" style={{marginBottom: 16}}>
            <button type="button" disabled={busy} onClick={() => editPlan()}>新计划</button>
            <button type="button" disabled={busy} onClick={() => void deletePlan(editing)}>删除计划</button>
          </div>}
        </form>
        <div className="material-detail">
          <h3>我的计划</h3>
          {loading ? <p role="status">正在读取计划…</p> : snapshot && (snapshot.plans.length ? <ul className="material-history">
            {snapshot.plans.map(plan => <li key={plan.id}>
              <button type="button" aria-pressed={editing?.id === plan.id} disabled={busy} onClick={() => editPlan(plan)}>
                <span>{plan.productName}</span>
                <small>{MOMENT_STYLES[plan.style]} · {plan.enabled ? `每天 ${plan.time}（北京时间）` : '定时未启用'}</small>
                {plan.enabled && plan.nextRunAt && <small>下次计划时间 {dateTime.format(new Date(plan.nextRunAt))}</small>}
              </button>
            </li>)}
          </ul> : <p>还没有计划。保存产品和文案风格后，就能手动生成或启用定时生成。</p>)}
        </div>
      </section>

      <section className="material-results" aria-labelledby={`${id}-history-title`}>
        <h3 id={`${id}-history-title`}>草稿历史</h3>
        {loading ? <p role="status">正在读取草稿…</p> : snapshot?.drafts.length === 0 && <p>还没有草稿。保存一个计划后，点「立即生成草稿」即可预览第一条。</p>}
        {selectedDraft && <article className="material-detail" ref={preview} aria-label={`${selectedDraft.productName}的朋友圈草稿`}>
          <h3>{selectedDraft.productName}</h3>
          <p role="status">{DRAFT_STATUS[selectedDraft.status]}</p>
          {selectedDraft.error && <p className={unfinished(selectedDraft) ? undefined : 'material-error'}>{selectedDraft.error}</p>}
          {selectedDraft.text && <>
            <p style={{whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text, #25272a)'}}>{selectedDraft.text}</p>
            <button type="button" onClick={() => void copy(selectedDraft.text!)}>复制文案</button>
          </>}
          {selectedDraft.files.map((file, index) => <div key={file.url}>
            {file.type.startsWith('image/') && <img className="material-image" style={{maxWidth: 440}} src={file.url} alt={`朋友圈配图 ${index + 1}`} loading="lazy"/>}
            <a href={file.url} download={file.name}>下载{selectedDraft.files.length > 1 ? `配图 ${index + 1}` : '配图'}</a>
          </div>)}
          {unfinished(selectedDraft) && <p style={{marginTop: 12}}>
            <button type="button" disabled={busy} onClick={() => void update({action: 'refresh', draftId: selectedDraft.id})}>查询生成状态</button>
          </p>}
        </article>}
        {!!snapshot?.drafts.length && <div className="material-detail" style={{marginTop: 16}}>
          <h3>最近生成</h3>
          <ul className="material-history">
            {snapshot.drafts.map(draft => <li key={draft.id}>
              <button type="button" aria-pressed={selectedDraft?.id === draft.id} onClick={() => {
                setSelectedDraftId(draft.id);
                preview.current?.scrollIntoView({block: 'nearest'});
              }}>
                <span>{draft.productName}</span>
                <small>{dateTime.format(new Date(draft.createdAt))} · {MOMENT_STYLES[draft.style]} · {draft.trigger === 'daily' ? '定时' : '手动'}</small>
                <small>{DRAFT_STATUS[draft.status]}</small>
              </button>
            </li>)}
          </ul>
        </div>}
      </section>
    </div>
  </div>;
}
