'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, ClipboardCheck, Loader2, RotateCcw } from 'lucide-react';
import { readWorkbenchResponse } from '../lib/api';
import type { RecordingProcessingDraft, RecordingProcessingSource, RecordingProcessingStatus } from '../lib/recording-processing-types';
import type { CustomerProfile, Deal, Mutate } from '../lib/types';
import './recording-processing-review.css';

type RequestState = { target: string; attempt: number };

const fields: readonly [keyof CustomerProfile, string][] = [
  ['decisionChain', '决策链与关键角色'], ['goals', '业务目标'], ['concerns', '关注点与顾虑'],
  ['budget', '预算情况'], ['timeline', '采购与决策时间'],
];

function projectLabel(project: Deal) {
  return project.projectName && project.projectName !== project.name ? `${project.name} · ${project.projectName}` : project.name;
}

function projectOptionLabel(project: Deal) {
  return [projectLabel(project), project.owner].filter(Boolean).join(' · ');
}

export function RecordingProcessingReview({ dealId, recordingId, jobId, projects, mutate, notify, onBusyChange, onDirtyChange }: {
  dealId: string;
  recordingId: string;
  jobId: string;
  projects: readonly Deal[];
  mutate: Mutate;
  notify: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const id = useId();
  const applyInFlight = useRef(false);
  const active = useRef(false);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const [request, setRequest] = useState<RequestState>({ target: '', attempt: 0 });
  const [settled, setSettled] = useState<RequestState | null>(null);
  const [draft, setDraft] = useState<RecordingProcessingDraft | null>(null);
  const [target, setTarget] = useState('');
  const [profile, setProfile] = useState<Partial<CustomerProfile>>({});
  const [accepted, setAccepted] = useState<Partial<Record<keyof CustomerProfile, boolean>>>({});
  const [followup, setFollowup] = useState('');
  const [edited, setEdited] = useState(false);
  const [applied, setApplied] = useState<{ dealId: string | null } | null>(null);
  const [applying, setApplying] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [applyError, setApplyError] = useState('');

  const generating = settled !== request;
  const targetProject = projects.find(item => item.id === target && !item.archive);
  const currentTarget = Boolean(targetProject && draft?.matchedDealId === targetProject.id && draft.targetVersion === targetProject.version);
  const hasAccepted = fields.some(([field]) => accepted[field] && Boolean(profile[field]?.trim()));
  const blankAccepted = fields.some(([field]) => accepted[field] && !profile[field]?.trim());
  const dirty = Boolean(!applied && (edited || (draft && target !== (draft.matchedDealId ?? request.target))));

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const parameters = { dealId, recordingId, jobId, ...(request.target ? { targetDealId: request.target } : {}) } satisfies RecordingProcessingSource;
    async function load() {
      try {
        const response = await fetch(`/api/recording-processing?${new URLSearchParams(parameters)}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        let result = await readWorkbenchResponse<RecordingProcessingStatus>(response, '暂时无法读取录音整理结果。');
        if (controller.signal.aborted) return;
        if (!result.draft && !result.applied) {
          const generated = await fetch('/api/recording-processing', {
            method: 'POST', credentials: 'same-origin', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parameters),
          });
          result = await readWorkbenchResponse<RecordingProcessingStatus>(generated, '录音整理失败，请重试。');
        }
        if (controller.signal.aborted) return;
        if (result.applied) { setDraft(result.draft ?? null); setApplied({ dealId: result.appliedDealId ?? null }); return; }
        if (!result.draft?.id) throw new Error('整理结果未完整返回，请重试。');
        setDraft(result.draft);
        setTarget(result.draft.matchedDealId ?? request.target);
        setProfile(result.draft.profile);
        setAccepted({});
        setFollowup(result.draft.followup);
        setEdited(false);
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : '录音整理失败，请重试。');
      } finally {
        if (!controller.signal.aborted) setSettled(request);
      }
    }
    void load();
    return () => controller.abort();
  }, [dealId, recordingId, jobId, request]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(applying); }, [applying, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); onDirtyChange?.(false); }, [onBusyChange, onDirtyChange]);

  function restart(nextTarget: string) {
    setLoadError('');
    setApplyError('');
    setRequest(current => ({ target: nextTarget, attempt: current.attempt + 1 }));
  }

  function rebind(nextTarget: string) {
    if (edited && !window.confirm('重新整理会替换尚未写入的修改。继续吗？')) return;
    restart(nextTarget);
  }

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !targetProject || !currentTarget || applyInFlight.current || generating || blankAccepted || (!hasAccepted && !followup.trim())) return;
    const changes: Partial<CustomerProfile> = {};
    for (const [field] of fields) {
      const value = profile[field]?.trim();
      if (accepted[field] && value) changes[field] = value;
    }
    applyInFlight.current = true;
    setApplying(true);
    setApplyError('');
    const targetId = targetProject.id;
    try {
      await mutate('recording_apply', {
        dealId: targetId, version: targetProject.version, sourceDealId: dealId, recordingId, jobId,
        draftId: draft.id, profile: changes, followup: followup.trim(), confirmed: true,
      });
      if (!active.current) return;
      setApplied({ dealId: targetId });
      setEdited(false);
      notify('整理结果已写入项目');
      requestAnimationFrame(() => resultHeading.current?.focus());
    } catch (cause) {
      if (active.current) {
        setApplyError(cause instanceof Error ? cause.message : '未能写入项目，请重试。');
        // The write may have won even if its response was interrupted. Check before allowing a retry.
        try {
          const response = await fetch(`/api/recording-processing?${new URLSearchParams({ dealId, recordingId, jobId })}`, { credentials: 'same-origin', cache: 'no-store' });
          const status = await readWorkbenchResponse<RecordingProcessingStatus>(response, '暂时无法读取写入结果。');
          if (active.current && status.applied) {
            setDraft(status.draft ?? null);
            setApplied({ dealId: status.appliedDealId });
            setEdited(false);
          }
        } catch { /* Keep the original write error and the user's edits. */ }
      }
    } finally {
      applyInFlight.current = false;
      if (active.current) setApplying(false);
    }
  }

  const summary = draft && <div className="recording-processing-summary">
        <h3>沟通摘要</h3>
        <p>{draft.summary || '这段录音未提炼出沟通摘要。'}</p>
        {draft.decisions.length > 0 && <><h3>确认事项（待核对）</h3><ul>{draft.decisions.map((decision, index) => <li key={index}>{decision}</li>)}</ul></>}
        {draft.evidence.length > 0 && <details><summary>转写依据<ChevronDown size={14} aria-hidden="true" /></summary><ul>{draft.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
      </div>;

  if (applied) {
    const appliedProject = projects.find(item => item.id === applied.dealId);
    return <section className="recording-processing-review" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} ref={resultHeading} tabIndex={-1}><Check size={17} aria-hidden="true" />整理结果已写入</h2>
      {appliedProject && <p>已写入{projectLabel(appliedProject)}。</p>}
      {summary}
    </section>;
  }

  const options = projects.filter(item => !item.archive);
  const optionCounts = new Map<string, number>();
  for (const project of options) {
    const label = projectOptionLabel(project);
    optionCounts.set(label, (optionCounts.get(label) ?? 0) + 1);
  }
  return <section className="recording-processing-review" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}><ClipboardCheck size={17} aria-hidden="true" />核对整理结果</h2>
    {generating && <p className="recording-processing-status" role="status"><Loader2 size={15} className="spin" aria-hidden="true" />正在整理转写内容…</p>}
    {loadError && <div className="recording-processing-feedback" role="alert"><p>{loadError}</p><button type="button" className="button secondary" onClick={() => rebind(request.target)}><RotateCcw size={14} aria-hidden="true" />重试整理</button></div>}
    {draft && <>
      {summary}
      <form className="recording-processing-form" onSubmit={event => void apply(event)} aria-labelledby={`${id}-heading`} aria-busy={applying}>
        <label className="recording-processing-field">
          <span>写入项目</span>
          <select value={targetProject?.id ?? ''} disabled={generating || applying} aria-describedby={`${id}-match`} onChange={event => {
            setTarget(event.target.value); setApplyError('');
          }}>
            <option value="">选择项目</option>
            {options.map(item => {
              const label = projectOptionLabel(item);
              return <option value={item.id} key={item.id}>{(optionCounts.get(label) ?? 0) > 1 ? `${label} · ${item.id}` : label}</option>;
            })}
          </select>
        </label>
        <p id={`${id}-match`} className="recording-processing-help">{draft.matchReason || (draft.projectName ? `录音提及${draft.projectName}，请核对写入项目。` : '请选择要写入的项目。')}</p>
        {targetProject && !currentTarget && <div className="recording-processing-feedback">
          <p>{draft.matchedDealId === targetProject.id ? '项目资料已更新，请重新整理后核对。' : '写入项目已切换，请按该项目重新整理。'}</p>
          <button type="button" className="button secondary" disabled={generating || applying} onClick={() => rebind(targetProject.id)}>按此项目重新整理</button>
        </div>}
        {currentTarget && <fieldset className="recording-processing-profile" disabled={generating || applying}>
          <legend>客户画像提议</legend>
          <p className="recording-processing-help">勾选后写入该字段。未勾选的内容保持原样。</p>
          {fields.map(([field, label]) => {
            const suggestion = draft.profile[field];
            if (!suggestion?.trim()) return null;
            const currentValue = targetProject?.customerProfile?.[field]?.trim();
            return <div className="recording-processing-profile-field" key={field}>
              <label className="recording-processing-choice"><input type="checkbox" checked={Boolean(accepted[field])} onChange={event => {
                setAccepted(previous => ({ ...previous, [field]: event.target.checked })); setEdited(true); setApplyError('');
              }} /><span>{currentValue ? '替换' : '接受'}{label}</span></label>
              {currentValue && <p className="recording-processing-current"><strong>当前内容</strong>{currentValue}</p>}
              <label className="recording-processing-field">
                <span>{label}建议</span>
                <textarea rows={2} maxLength={2000} value={profile[field] ?? ''} disabled={!accepted[field]} required={accepted[field]}
                  aria-invalid={accepted[field] && !profile[field]?.trim() ? true : undefined}
                  onChange={event => { setProfile(previous => ({ ...previous, [field]: event.target.value })); setEdited(true); setApplyError(''); }} />
              </label>
            </div>;
          })}
          {!fields.some(([field]) => draft.profile[field]?.trim()) && <p className="recording-processing-help">录音中没有可提议的画像字段。</p>}
        </fieldset>}
        <label className="recording-processing-field">
          <span>跟进事项</span>
          <textarea rows={3} maxLength={6000} value={followup} disabled={!currentTarget || generating || applying} aria-describedby={`${id}-followup-help`} onChange={event => {
            setFollowup(event.target.value); setEdited(true); setApplyError('');
          }} />
        </label>
        <p id={`${id}-followup-help`} className="recording-processing-help">留空可仅写入所勾选的画像字段。</p>
        {applyError && <p className="recording-processing-feedback" role="alert">{applyError}</p>}
        <footer className="recording-processing-actions">
          <span>请核对录音与项目，确认后才会写入。</span>
          <button type="submit" className="button primary" disabled={!currentTarget || generating || applying || blankAccepted || (!hasAccepted && !followup.trim())}>
            {applying ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
            {applying ? '正在写入…' : '确认写入'}
          </button>
        </footer>
      </form>
    </>}
  </section>;
}
