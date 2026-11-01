'use client';

import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, CircleAlert, Eye, EyeOff, Loader2 } from 'lucide-react';
import { BrandMark } from './CoreViews';
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
    <div className="workspace-login-brand"><BrandMark small /><span>CTAI <span>营销工作台</span></span></div>
    <section className="workspace-login-panel" aria-labelledby="workspace-login-title">
      <h1 id="workspace-login-title">登录营销工作台</h1>
      <p className="workspace-login-description">使用你的工作账号，进入对应的工作台。</p>
      <form onSubmit={submit} aria-busy={busy}>
        <div className="workspace-login-field"><label htmlFor="workspace-username">账号</label><input id="workspace-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} maxLength={80} disabled={busy} onChange={event => { setUsername(event.target.value); setValidation(''); }} required placeholder="请输入账号" /></div>
        <div className="workspace-login-field"><label htmlFor="workspace-password">密码</label><div className="workspace-password-input"><input id="workspace-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} maxLength={256} disabled={busy} onChange={event => { setPassword(event.target.value); setValidation(''); }} required placeholder="请输入密码" /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div></div>
        {(validation || error) && <p className="workspace-login-error" role="alert"><CircleAlert size={18} /><span>{validation || error}</span></p>}
        <button type="submit" className="workspace-login-submit" disabled={busy}>{busy ? <><Loader2 size={19} className="spin" />正在登录…</> : <>登录<ArrowRight size={18} /></>}</button>
      </form>
      <p className="workspace-login-help">忘记账号或密码，请联系管理员。</p>
    </section>
    <p className="workspace-login-footer">客户、项目与团队协作，在一处有序推进。</p>
  </main>;
}
