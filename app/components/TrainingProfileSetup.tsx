'use client';

import { useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, Info, Loader2, Mic, UserRound } from 'lucide-react';
import { defaultTrainingProfile, trainingProfileLimits, type TrainingProfile } from '../lib/training-profile';
import './training-profile.css';

type SetupProps = {
  scenario: string;
  voice: boolean;
  busy: boolean;
  error: string;
  modelConnected: boolean;
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

export function TrainingProfileSetup({ scenario, voice, busy, error, modelConnected, onEdit, onConfirm }: SetupProps) {
  const [draft, setDraft] = useState<TrainingProfile>(() => defaultTrainingProfile(scenario));
  const [reviewed, setReviewed] = useState<TrainingProfile | null>(null);
  const [validationError, setValidationError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const editHeading = useRef<HTMLHeadingElement>(null);
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
      document.getElementById(fieldId(emptyField))?.focus();
      return;
    }
    onEdit();
    setReviewed(profile);
    requestAnimationFrame(() => reviewHeading.current?.focus());
  };
  const backToEdit = () => {
    if (busy) return;
    setReviewed(null);
    onEdit();
    requestAnimationFrame(() => editHeading.current?.focus());
  };
  const confirm = async () => {
    if (!reviewed || busy || confirming.current) return;
    confirming.current = true;
    try { await onConfirm({ ...reviewed }); }
    finally { confirming.current = false; }
  };

  return <section className="training-profile-setup" aria-label="设置并确认客户画像" aria-busy={busy}>
    <ol className="training-profile-steps" aria-label="画像确认步骤">
      <li aria-current={!reviewed ? 'step' : undefined}><span aria-hidden="true">{reviewed ? <Check size={12} /> : '1'}</span>设置客户画像</li>
      <li aria-current={reviewed ? 'step' : undefined}><span aria-hidden="true">2</span>确认并开始</li>
    </ol>
    {!reviewed ? <>
      <div className="training-profile-heading"><h2 ref={editHeading} tabIndex={-1}>这次，你想和怎样的客户沟通？</h2><p>已按「{scenario}」填入客户画像，可按练习目标修改。切换场景会重新载入画像。</p></div>
      <form ref={formRef} onSubmit={event => event.preventDefault()} className="training-profile-form">
        <fieldset className="training-profile-fields training-profile-background" disabled={busy}>
          <legend>客户背景</legend>
          <label htmlFor={fieldId('name')}>客户称呼<input id={fieldId('name')} value={draft.name} onChange={event => update('name', event.target.value)} maxLength={trainingProfileLimits.name} required autoComplete="off" /></label>
          <label htmlFor={fieldId('industry')}>所在行业<input id={fieldId('industry')} value={draft.industry} onChange={event => update('industry', event.target.value)} maxLength={trainingProfileLimits.industry} required autoComplete="off" /></label>
          <label htmlFor={fieldId('role')}>客户角色<input id={fieldId('role')} value={draft.role} onChange={event => update('role', event.target.value)} maxLength={trainingProfileLimits.role} required autoComplete="off" /></label>
        </fieldset>
        <fieldset className="training-profile-fields" disabled={busy}>
          <legend>这次要谈的事</legend>
          <label className="training-profile-field-wide" htmlFor={fieldId('need')}>业务需求<textarea id={fieldId('need')} rows={2} value={draft.need} onChange={event => update('need', event.target.value)} maxLength={trainingProfileLimits.need} required /></label>
          <label htmlFor={fieldId('budget')}>预算范围<input id={fieldId('budget')} value={draft.budget} onChange={event => update('budget', event.target.value)} maxLength={trainingProfileLimits.budget} required autoComplete="off" /></label>
          <label htmlFor={fieldId('timeline')}>时间安排<input id={fieldId('timeline')} value={draft.timeline} onChange={event => update('timeline', event.target.value)} maxLength={trainingProfileLimits.timeline} required autoComplete="off" /></label>
          <label className="training-profile-field-wide" htmlFor={fieldId('decisionMode')}>决策方式<select id={fieldId('decisionMode')} value={draft.decisionMode} onChange={event => update('decisionMode', event.target.value as TrainingProfile['decisionMode'])}>{decisionModes.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        </fieldset>
        <fieldset className="training-profile-fields" disabled={busy}>
          <legend>沟通与挑战</legend>
          <label htmlFor={fieldId('communicationStyle')}>沟通风格<select id={fieldId('communicationStyle')} value={draft.communicationStyle} onChange={event => update('communicationStyle', event.target.value as TrainingProfile['communicationStyle'])}>{communicationStyles.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label htmlFor={fieldId('difficulty')}>练习难度<select id={fieldId('difficulty')} value={draft.difficulty} onChange={event => update('difficulty', event.target.value as TrainingProfile['difficulty'])}>{difficulties.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="training-profile-field-wide" htmlFor={fieldId('concern')}>核心顾虑<textarea id={fieldId('concern')} rows={2} value={draft.concern} onChange={event => update('concern', event.target.value)} maxLength={trainingProfileLimits.concern} required /></label>
        </fieldset>
        {validationError && <div className="training-profile-error" role="alert"><Info size={16} /><p>{validationError}</p></div>}
        <div className="training-profile-actions"><p>下一步先核对画像，再开始对话。</p><button type="button" className="studio-btn studio-btn-primary" disabled={busy} onClick={preview}>预览客户画像<ArrowRight size={16} /></button></div>
      </form>
    </> : <>
      <div className="training-profile-heading"><h2 ref={reviewHeading} tabIndex={-1}>确认客户画像</h2><p>练习场景：{scenario}。系统将依据这份画像扮演客户，本次练习会保存已确认的版本。</p></div>
      <div className="training-profile-preview"><ProfileFacts profile={reviewed} /></div>
      <div className="training-profile-ready"><Check size={16} /><p>{modelConnected ? '使用已配置模型生成客户回应。' : '使用本地规则生成客户回应。'}{voice ? '确认后可连接语音，麦克风将由你开启。' : '确认后即可开始文字对话。'}</p></div>
      {error && <div className="training-profile-error" role="alert"><Info size={16} /><div><p>{error}</p><span>画像已保留，可重试开始或返回修改。</span></div></div>}
      <div className="training-profile-actions training-profile-confirm-actions"><button type="button" className="studio-btn studio-btn-ghost" disabled={busy} onClick={backToEdit}><ArrowLeft size={15} />返回修改</button><button type="button" className="studio-btn studio-btn-primary" disabled={busy} onClick={() => void confirm()}>{busy ? <Loader2 size={16} className="studio-spin" /> : voice ? <Mic size={16} /> : <Check size={16} />}{busy ? '正在准备客户…' : `确认画像，开始${voice ? '语音' : ''}带练`}</button></div>
    </>}
  </section>;
}
