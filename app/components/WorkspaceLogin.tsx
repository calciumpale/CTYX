'use client';

import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, CircleAlert, Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { BrandMark } from './CoreViews';
import { LoginShowcaseIllustration } from './VisualIllustrations';
import './role-workspaces.css';

export interface WorkspaceLoginProps {
  onLogin: (username: string, password: string) => Promise<void>;
  error?: string;
  busy: boolean;
}

export default function WorkspaceLogin({ onLogin, error, busy }: WorkspaceLoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [validation, setValidation] = useState('');
  const submitted = useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || submitted.current) return;
    if (!username.trim() || !password) {
      setValidation('请填写账号和密码。');
      return;
    }
    setValidation('');
    submitted.current = true;
    try { await onLogin(username.trim(), password); }
    finally { submitted.current = false; }
  };

  return <main className="workspace-login">
    <div className="workspace-login-shell">
      <aside className="workspace-login-showcase" aria-hidden="true">
        <div className="workspace-login-showcase-top">
          <div className="workspace-login-brand workspace-login-brand-light">
            <span className="workspace-login-emblem"><BrandMark small /></span>
            <span>AI营销工作台</span>
          </div>
          <span className="workspace-login-live-pill"><i />多专家协同 · 事实可溯源</span>
        </div>
        <div className="workspace-login-showcase-copy">
          <h2>让每一次客户推进都有据可依</h2>
          <p>打通智能获客初筛、商机深度洞察、合同风险审查与话术沉淀。</p>
        </div>
        <div className="workspace-login-hero-graphic">
          <LoginShowcaseIllustration />
        </div>
        <p className="workspace-login-showcase-foot">智能获客初筛 · 商机深度洞察 · 合同风控审阅 · 团队经验沉淀</p>
      </aside>
      <section className="workspace-login-panel" aria-labelledby="workspace-login-title">
        <div className="workspace-login-header">
          <div className="workspace-login-brand workspace-login-brand-mobile"><span className="workspace-login-emblem" aria-hidden="true"><BrandMark small /></span><span>AI营销工作台</span></div>
          <span className="workspace-login-kicker">WORKSPACE ACCESS</span>
          <h1 id="workspace-login-title">登录工作空间</h1>
          <p className="workspace-login-description">使用你的岗位账号进入对应科室与权限空间。</p>
        </div>
        <form onSubmit={submit} aria-busy={busy}>
          <div className="workspace-login-field"><label htmlFor="workspace-username">账号</label><input id="workspace-username" name="username" placeholder="请输入工作台账号" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} maxLength={80} disabled={busy} onChange={event => { setUsername(event.target.value); setValidation(''); }} required /></div>
          <div className="workspace-login-field"><label htmlFor="workspace-password">密码</label><div className="workspace-password-input"><input id="workspace-password" name="password" placeholder="请输入登录密码" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} maxLength={256} disabled={busy} onChange={event => { setPassword(event.target.value); setValidation(''); }} required /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></div>
          {(validation || error) && <p className="workspace-login-error" role="alert"><CircleAlert size={17} /><span>{validation || error}</span></p>}
          <button type="submit" className="workspace-login-submit" disabled={busy}>{busy ? <><Loader2 size={17} className="spin" />正在登录…</> : <>进入工作台<ArrowRight size={16} /></>}</button>
        </form>
        <div className="workspace-login-meta">
          <span><ShieldCheck size={14} aria-hidden="true" />岗位权限与部门资料按会话严格隔离</span>
          <p className="workspace-login-help">忘记账号或密码，请联系系统管理员。</p>
        </div>
      </section>
    </div>
  </main>;
}
