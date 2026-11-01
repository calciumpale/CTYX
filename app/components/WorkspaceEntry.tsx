'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import type { MemberSession } from '../lib/member-types';
import Workbench from './Workbench';
import WorkspaceLogin from './WorkspaceLogin';
import { BusinessSettingsProvider } from './BusinessSettingsContext';
import './role-workspaces.css';

class WorkspaceSessionError extends Error {}

function isMember(value: unknown): value is MemberSession {
  if (!value || typeof value !== 'object') return false;
  const member = value as Partial<MemberSession>;
  return typeof member.accountId === 'string' && !!member.accountId && typeof member.username === 'string' && typeof member.displayName === 'string' && ['sales', 'manager', 'admin'].includes(member.role || '');
}

export default function WorkspaceEntry() {
  const [member, setMember] = useState<MemberSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loginError, setLoginError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const accountId = useRef<string | null>(null);

  useEffect(() => { accountId.current = member?.accountId || null; }, [member?.accountId]);

  useEffect(() => {
    const previousFetch = window.fetch;
    const scopedFetch: typeof window.fetch = async (input, init) => {
      const requestAccount = accountId.current;
      const requestGeneration = generation.current;
      const result = await previousFetch.call(window, input, init);
      if (result.status !== 401 || !requestAccount || requestAccount !== accountId.current || requestGeneration !== generation.current || !mounted.current) return result;
      const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) return result;
      try {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        if (url.origin === window.location.origin && url.pathname.startsWith('/api/') && url.pathname !== '/api/workspace-session') window.dispatchEvent(new Event('ctai-session-expired'));
      } catch { /* An unrelated request must not affect the work account session. */ }
      return result;
    };
    window.fetch = scopedFetch;
    return () => { if (window.fetch === scopedFetch) window.fetch = previousFetch; };
  }, []);

  useEffect(() => {
    mounted.current = true;
    const expired = () => {
      generation.current += 1;
      accountId.current = null;
      request.current?.abort();
      setMember(null);
      setLoading(false);
      setBusy(false);
      setLoadError('');
      setLoginError('登录已过期，请重新登录。');
    };
    window.addEventListener('ctai-session-expired', expired);
    return () => { mounted.current = false; generation.current += 1; request.current?.abort(); window.removeEventListener('ctai-session-expired', expired); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const current = ++generation.current;
    void (async () => {
      try {
        const response = await fetch('/api/workspace-session', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const body: unknown = await response.json();
        if (!response.ok) throw new WorkspaceSessionError('暂时无法连接工作台，请检查网络后重试。');
        if (!body || typeof body !== 'object' || !('authenticated' in body) || typeof body.authenticated !== 'boolean') throw new WorkspaceSessionError('登录状态读取失败，请重试。');
        const value = body as { authenticated: boolean; member?: unknown };
        if (value.authenticated && !isMember(value.member)) throw new WorkspaceSessionError('账号信息读取失败，请重试。');
        if (mounted.current && current === generation.current) { accountId.current = value.authenticated ? (value.member as MemberSession).accountId : null; setMember(value.authenticated ? value.member as MemberSession : null); }
      } catch (failure) {
        if (mounted.current && current === generation.current && !controller.signal.aborted) setLoadError(failure instanceof WorkspaceSessionError ? failure.message : '登录状态读取失败，请检查网络后重试。');
      } finally { if (mounted.current && current === generation.current) setLoading(false); }
    })();
    return () => controller.abort();
  }, [reload]);

  const login = useCallback(async (username: string, password: string) => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const current = ++generation.current;
    setBusy(true);
    setLoginError('');
    try {
      const response = await fetch('/api/workspace-session', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }), signal: controller.signal });
      const body = await response.json() as { member?: unknown; error?: unknown };
      if (!response.ok) throw new WorkspaceSessionError(typeof body?.error === 'string' ? body.error : '登录未完成，请稍后重试。');
      if (!isMember(body?.member)) throw new WorkspaceSessionError('账号信息读取失败，请重新登录。');
      if (mounted.current && current === generation.current) { accountId.current = body.member.accountId; setMember(body.member); }
    } catch (failure) {
      if (mounted.current && current === generation.current && !controller.signal.aborted) setLoginError(failure instanceof WorkspaceSessionError ? failure.message : '登录未完成，请检查网络后重试。');
    } finally { if (mounted.current && current === generation.current) setBusy(false); }
  }, []);

  const logout = useCallback(async () => {
    const current = ++generation.current;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    try {
      const response = await fetch('/api/workspace-session', { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('logout');
      if (mounted.current && current === generation.current) { accountId.current = null; setMember(null); setLoginError(''); }
    } catch {
      if (!controller.signal.aborted) throw new Error(`退出登录未完成，已保留${member?.displayName || '当前账号'}的会话，请重试。`);
    }
  }, [member?.displayName]);

  if (loading) return <main className="workspace-session-state" role="status"><Loader2 size={25} className="spin" /><p>正在打开工作台…</p></main>;
  if (loadError) return <main className="workspace-session-state"><CircleAlert size={28} /><h1>工作台暂时无法连接</h1><p role="alert">{loadError}</p><button className="button secondary" onClick={() => { setLoading(true); setLoadError(''); setReload(value => value + 1); }}><RefreshCw size={17} />重新连接</button></main>;
  if (!member) return <WorkspaceLogin onLogin={login} error={loginError} busy={busy} />;
  return <BusinessSettingsProvider key={member.accountId}><Workbench key={member.accountId} member={member} onLogout={logout} /></BusinessSettingsProvider>;
}
