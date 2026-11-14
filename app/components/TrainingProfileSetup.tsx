'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Info, Loader2, Mic, UserRound } from 'lucide-react';
import { defaultTrainingProfile, trainingProfileLimits, type TrainingProfile } from '../lib/training-profile';
import './training-profile.css';

type SetupProps = {
  scenario: string;
  voice: boolean;
  busy: boolean;
  error: string;
  modelConnected: boolean;
  modeSelection: ReactNode;
  voiceSelection: ReactNode;
  onEdit: () => void;
  onConfirm: (profile: TrainingProfile) => Promise<void>;
};

const decisionModes: TrainingProfile['decisionMode'][] = ['本人决策', '与合伙人共同决策', '需上级审批'];
const communicationStyles: TrainingProfile['communicationStyle'][] = ['直接干脆', '谨慎细致', '健谈随和', '强势质疑'];
const difficulties: TrainingProfile['difficulty'][] = ['入门', '进阶', '挑战'];

function ProfileFacts({ profile }: { profile: TrainingProfile }) {
  return <>
    <div className="training-profile-person">
      <span className="training-profile-avatar" aria-hidden="true"><UserRound size={23} /></span>
      <div><h3>{profile.name}<span>{profile.role}</span></h3><p>{profile.industry}</p></div>
    </div>
    <dl className="training-profile-facts">
      <div className="training-profile-fact-wide"><dt>业务需求</dt><dd>{profile.need}</dd></div>
      <div><dt>预算范围</dt><dd>{profile.budget}</dd></div>
      <div><dt>时间安排</dt><dd>{profile.timeline}</dd></div>
      <div><dt>决策方式</dt><dd>{profile.decisionMode}</dd></div>
      <div><dt>沟通风格</dt><dd>{profile.communicationStyle}</dd></div>
      <div className="training-profile-fact-wide"><dt>核心顾虑</dt><dd>{profile.concern}</dd></div>
      <div><dt>练习难度</dt><dd>{profile.difficulty}</dd></div>
    </dl>
  </>;
}

export function TrainingSessionProfile({ profile }: { profile?: TrainingProfile; mode?: 'demo' | 'live' }) {
  if (!profile) return <div className="training-profile-legacy"><p>本次练习未设置画像。</p></div>;
  return <details className="training-confirmed-profile">
    <summary><UserRound size={15} /><span><strong>{profile.name}</strong><span>{profile.industry} · {profile.role} · {profile.difficulty}</span></span><span className="training-profile-summary-action">已确认画像<ChevronDown size={14} /></span></summary>
    <div className="training-confirmed-profile-content"><ProfileFacts profile={profile} /></div>
  </details>;
}

export function TrainingProfileSetup({ scenario, voice, busy, error, modelConnected, modeSelection, voiceSelection, onEdit, onConfirm }: SetupProps) {
  const [draft, setDraft] = useState<TrainingProfile>(() => defaultTrainingProfile(scenario));
  const [reviewed, setReviewed] = useState<TrainingProfile | null>(null);
  const [validationError, setValidationError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const profileEditor = useRef<HTMLDetailsElement>(null);
  const profileEditToggle = useRef<HTMLElement>(null);
  const confirming = useRef(false);
  const id = useId();
  const fieldId = (field: keyof TrainingProfile) => `${id}-${field}`;

  const update = <K extends keyof TrainingProfile>(field: K, value: TrainingProfile[K]) => {
    setDraft(current => ({ ...current, [field]: value }));
    setReviewed(null);
    setValidationError('');
    onEdit();
  };
  const preview = () => {
    if (busy || !formRef.current?.reportValidity()) return;
    const profile = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()])) as TrainingProfile;
    const emptyField = (Object.keys(profile) as (keyof TrainingProfile)[]).find(field => !profile[field]);
    if (emptyField) {
      setValidationError('请填写完整画像，内容不能只有空格。');
      const field = document.getElementById(fieldId(emptyField));
      if (profileEditor.current) profileEditor.current.open = true;
      const disclosure = field?.closest('details');
      if (disclosure) disclosure.open = true;
      field?.focus();
      return;
    }
    onEdit();
    setReviewed(profile);
    if (profileEditor.current) profileEditor.current.open = false;
    requestAnimationFrame(() => reviewHeading.current?.focus());
  };
  const backToEdit = () => {
    if (busy) return;
    setReviewed(null);
    onEdit();
    if (profileEditor.current) profileEditor.current.open = true;
    requestAnimationFrame(() => profileEditToggle.current?.focus());
  };
  const confirm = async () => {
    if (!reviewed || busy || confirming.current) return;
    confirming.current = true;
    try { await onConfirm({ ...reviewed }); }
    finally { confirming.current = false; }
  };

  return <>
    <section className="training-setup-card training-setup-person" aria-labelledby={`${id}-person-heading`}>
      <h2 id={`${id}-person-heading`}>人物及音色</h2>
      <div className="training-profile-person">
        <span className="training-profile-avatar" aria-hidden="true"><UserRound size={21} /></span>
        <div><strong>{draft.name} <small>{draft.role}</small></strong><p>{draft.industry}</p></div>
      </div>
      <details ref={profileEditor} className="training-profile-editor" onInvalidCapture={event => { event.currentTarget.open = true; }}>
        <summary ref={profileEditToggle}>编辑客户画像<ChevronDown size={14} aria-hidden="true" /></summary>
        <p className="training-setup-help">切换剧本会重置画像。</p>
        <form ref={formRef} onSubmit={event => event.preventDefault()} className="training-profile-form" aria-labelledby={`${id}-person-heading`}>
          <fieldset className="training-profile-fields" aria-label="练习目标" disabled={busy}>
            <label className="training-profile-field-wide" htmlFor={fieldId('need')}>业务需求<textarea id={fieldId('need')} rows={2} value={draft.need} onChange={event => update('need', event.target.value)} maxLength={trainingProfileLimits.need} required /></label>
            <label className="training-profile-field-wide" htmlFor={fieldId('concern')}>核心顾虑<textarea id={fieldId('concern')} rows={2} value={draft.concern} onChange={event => update('concern', event.target.value)} maxLength={trainingProfileLimits.concern} required /></label>
            <label htmlFor={fieldId('communicationStyle')}>沟通风格<select id={fieldId('communicationStyle')} value={draft.communicationStyle} onChange={event => update('communicationStyle', event.target.value as TrainingProfile['communicationStyle'])}>{communicationStyles.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            <label htmlFor={fieldId('difficulty')}>练习难度<select id={fieldId('difficulty')} value={draft.difficulty} onChange={event => update('difficulty', event.target.value as TrainingProfile['difficulty'])}>{difficulties.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          </fieldset>
          <details className="training-profile-advanced" onInvalidCapture={event => { event.currentTarget.open = true; }}>
            <summary>客户背景与决策条件<ChevronDown size={14}/></summary>
            <fieldset className="training-profile-fields training-profile-background" aria-label="客户背景" disabled={busy}>
              <label htmlFor={fieldId('name')}>客户称呼<input id={fieldId('name')} value={draft.name} onChange={event => update('name', event.target.value)} maxLength={trainingProfileLimits.name} required autoComplete="off" /></label>
              <label htmlFor={fieldId('industry')}>所在行业<input id={fieldId('industry')} value={draft.industry} onChange={event => update('industry', event.target.value)} maxLength={trainingProfileLimits.industry} required autoComplete="off" /></label>
              <label htmlFor={fieldId('role')}>客户角色<input id={fieldId('role')} value={draft.role} onChange={event => update('role', event.target.value)} maxLength={trainingProfileLimits.role} required autoComplete="off" /></label>
              <label htmlFor={fieldId('budget')}>预算范围<input id={fieldId('budget')} value={draft.budget} onChange={event => update('budget', event.target.value)} maxLength={trainingProfileLimits.budget} required autoComplete="off" /></label>
              <label htmlFor={fieldId('timeline')}>时间安排<input id={fieldId('timeline')} value={draft.timeline} onChange={event => update('timeline', event.target.value)} maxLength={trainingProfileLimits.timeline} required autoComplete="off" /></label>
              <label htmlFor={fieldId('decisionMode')}>决策方式<select id={fieldId('decisionMode')} value={draft.decisionMode} onChange={event => update('decisionMode', event.target.value as TrainingProfile['decisionMode'])}>{decisionModes.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            </fieldset>
          </details>
          {validationError && <div className="training-profile-error" role="alert"><Info size={16} /><p>{validationError}</p></div>}
        </form>
      </details>
      <div className="training-setup-voice">{voiceSelection}</div>
    </section>
    <section className="training-setup-card training-setup-mode" aria-labelledby={`${id}-mode-heading`}>
      <h2 id={`${id}-mode-heading`}>选陪练方式</h2>
      {modeSelection}
    </section>
    <section className="training-setup-card training-setup-start" aria-labelledby={`${id}-start-heading`}>
      <h2 id={`${id}-start-heading`}>开始陪练</h2>
      {reviewed ? <>
        <div className="training-profile-heading"><h3 ref={reviewHeading} tabIndex={-1}>确认客户画像</h3><p>{scenario} · 按以下画像扮演客户并保存本次版本。</p></div>
        <div className="training-profile-preview"><ProfileFacts profile={reviewed} /></div>
        {error && <div className="training-profile-error" role="alert"><Info size={16} /><div><p>{error}</p><span>画像已保留，可重试开始或返回修改。</span></div></div>}
      </> : <p className="training-setup-help">确认客户画像后，进入练习对话。</p>}
      <div className="training-profile-ready"><Check size={15} aria-hidden="true" /><p>{modelConnected ? '已配置模型' : '本地规则'}{voice ? ' · 语音连接后由你开启麦克风' : ' · 文字对话'}</p></div>
      <div className="training-profile-actions">
        {reviewed ? <>
          <button type="button" className="studio-btn studio-btn-ghost" disabled={busy} onClick={backToEdit}><ArrowLeft size={15} aria-hidden="true" />返回修改</button>
          <button type="button" className="studio-btn studio-btn-primary" disabled={busy} onClick={() => void confirm()}>{busy ? <Loader2 size={16} className="studio-spin" aria-hidden="true" /> : voice ? <Mic size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{busy ? '正在准备客户…' : `开始${voice ? '语音' : ''}陪练`}</button>
        </> : <button type="button" className="studio-btn studio-btn-primary" disabled={busy} onClick={preview}>预览并确认<ArrowRight size={16} aria-hidden="true" /></button>}
      </div>
    </section>
  </>;
}
