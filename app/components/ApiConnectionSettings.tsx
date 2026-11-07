'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, CheckCircle2, CircleAlert, Eye, EyeOff, KeyRound, Loader2, PlugZap, RotateCcw, ShieldCheck } from 'lucide-react';
import type { ConnectionActionResult, ConnectionSummary, ConnectionsSnapshot } from '../lib/connection-types';
import './api-settings.css';

type Draft = { enabled: boolean; baseUrl: string; modelName: string };
type FieldErrors = Partial<Record<'baseUrl' | 'modelName' | 'secret', string>>;
type Feedback = { type: 'success' | 'error' | 'info'; message: string; latencyMs?: number };
type PendingAction = 'load' | 'save' | 'test' | 'remove' | null;

const toDraft = (connection: ConnectionSummary): Draft => ({ enabled: connection.enabled, baseUrl: connection.baseUrl, modelName: connection.modelName });

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null) as (T & { error?: string; message?: string }) | null;
  if (!response.ok) throw new Error(data?.error || data?.message || (response.status === 401 ? '登录状态已失效，请重新登录。' : '暂时无法完成请求，请稍后重试。'));
  if (!data) throw new Error('服务返回的数据不完整，请稍后重试。');
  return data;
}

export function ApiConnectionSettings({ onSaved }: { onSaved?: () => Promise<void> | void }) {
  const id = useId();
  const [connection, setConnection] = useState<ConnectionSummary | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [draft, setDraft] = useState<Draft>({ enabled: false, baseUrl: '', modelName: '' });
  const [hasNewSecret, setHasNewSecret] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [pending, setPending] = useState<PendingAction>('load');
  const [loadError, setLoadError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [conflict, setConflict] = useState(false);
  const busy = useRef(false);
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const secretInput = useRef<HTMLInputElement | null>(null);
  const baseUrlInput = useRef<HTMLInputElement | null>(null);
  const modelInput = useRef<HTMLInputElement | null>(null);
  const attachSecretInput = useCallback((node: HTMLInputElement | null) => {
    // A new credential exists only in this input and is erased on unmount.
    if (!node && secretInput.current) secretInput.current.value = '';
    secretInput.current = node;
  }, []);

  const clearSecret = useCallback(() => {
    if (secretInput.current) secretInput.current.value = '';
    setHasNewSecret(false);
    setShowSecret(false);
  }, []);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const abort = new AbortController();
    controller.current = abort;
    try {
      const response = await fetch('/api/connections', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
      const snapshot = await readResponse<ConnectionsSnapshot>(response);
      if (!alive.current || abort.signal.aborted) return;
      if (!snapshot.model || typeof snapshot.storageReady !== 'boolean') throw new Error('配置数据不完整，请重试。');
      setConnection(snapshot.model);
      setStorageReady(snapshot.storageReady);
      setDraft(toDraft(snapshot.model));
      setFieldErrors({});
      setConflict(false);
      clearSecret();
    } catch (cause) {
      if (alive.current && !abort.signal.aborted) setLoadError(cause instanceof Error ? cause.message : '无法读取 API 配置，请重试。');
    } finally {
      if (controller.current === abort) {
        busy.current = false;
        if (alive.current && !abort.signal.aborted) setPending(null);
      }
    }
  }, [clearSecret]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    // Defer the initial request until mount settles, avoiding a duplicate
    // request during React's development setup/cleanup cycle.
    queueMicrotask(() => { if (!cancelled) void load(); });
    return () => {
      cancelled = true;
      alive.current = false;
      controller.current?.abort();
      controller.current = null;
      busy.current = false;
    };
  }, [load]);

  const reload = () => {
    if (busy.current) return;
    setPending('load');
    setLoadError('');
    setFeedback(null);
    void load();
  };

  const dirty = !!connection && (draft.enabled !== connection.enabled || draft.baseUrl !== connection.baseUrl || draft.modelName !== connection.modelName || hasNewSecret);
  const disabled = pending !== null || !connection || !!loadError;

  const updateDraft = (patch: Partial<Draft>) => {
    if (busy.current) return;
    setDraft(current => ({ ...current, ...patch }));
    setFieldErrors({});
    setFeedback(null);
  };

  const perform = async (action: 'save' | 'test' | 'remove', event?: FormEvent) => {
    event?.preventDefault();
    if (busy.current || !connection || loadError || !storageReady) return;
    const secret = secretInput.current?.value ?? '';
    if (action !== 'remove' && (action === 'test' || draft.enabled)) {
      const errors: FieldErrors = {};
      if (!draft.baseUrl.trim()) errors.baseUrl = '请填写服务的 Base URL。';
      else {
        try {
          const url = new URL(draft.baseUrl.trim());
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) errors.baseUrl = '请填写有效的 API 地址，地址中不要包含密钥。';
        } catch { errors.baseUrl = '请填写完整的 API 地址，如 https://api.example.com/v1。'; }
      }
      if (!draft.modelName.trim()) errors.modelName = '请填写服务提供方支持的模型名称。';
      if (!secret.trim() && !connection.hasSecret) errors.secret = '请填写 API Key。';
      if (Object.keys(errors).length) {
        setFieldErrors(errors);
        setFeedback(null);
        if (errors.baseUrl) baseUrlInput.current?.focus();
        else if (errors.modelName) modelInput.current?.focus();
        else secretInput.current?.focus();
        return;
      }
    }
    busy.current = true;
    setPending(action);
    setFieldErrors({});
    setFeedback(null);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const response = await fetch('/api/connections', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'remove' ? { action, kind: 'model', version: connection.version } : {
          action, kind: 'model', version: connection.version, enabled: draft.enabled,
          baseUrl: draft.baseUrl.trim(), modelName: draft.modelName.trim(), secret,
        }),
      });
      if (response.status === 409 && alive.current && !abort.signal.aborted) setConflict(true);
      const result = await readResponse<ConnectionActionResult>(response);
      if (!alive.current || abort.signal.aborted) return;
      if (action === 'test') {
        if (!result.test?.ok) throw new Error(result.error || '服务未返回有效的测试结果，请重试。');
        setFeedback({ type: 'success', message: `${result.test.detail} 本次结果仅对应当前表单，测试不会保存配置。`, latencyMs: result.test.latencyMs });
      } else {
        if (!result.connection) throw new Error('操作结果不完整，请重新加载配置后确认。');
        setConnection(result.connection);
        setDraft(toDraft(result.connection));
        setConflict(false);
        clearSecret();
        setFeedback({ type: 'info', message: action === 'save' ? '配置已保存并立即生效。连接尚未测试，可点击「测试连接」验证。' : '已移除当前账户配置，恢复部署默认值。连接尚未测试。' });
        try { await onSaved?.(); }
        catch {
          if (alive.current && !abort.signal.aborted) setFeedback({ type: 'info', message: 'API 配置已保存；工作台状态刷新未完成，重新进入页面即可更新。' });
        }
      }
    } catch (cause) {
      if (alive.current && !abort.signal.aborted) {
        const message = cause instanceof Error ? cause.message : '操作未完成，请重试。';
        setFeedback({ type: 'error', message: secret ? message.split(secret).join('[密钥已隐藏]') : message });
      }
    } finally {
      if (controller.current === abort) {
        busy.current = false;
        if (alive.current && !abort.signal.aborted) setPending(null);
      }
    }
  };

  const status = feedback?.type === 'success' ? '当前表单测试通过' : !connection ? '读取配置中' : !connection.configured ? (connection.enabled ? '配置未完成' : '尚未启用') : !connection.enabled ? '调用已关闭' : '已配置 · 待测试';
  const source = connection?.source === 'account' ? '当前账户配置' : connection?.source === 'environment' ? '部署默认配置' : '尚未配置';

  return <section className="api-settings" id="api-configuration" aria-labelledby={`${id}-title`} aria-busy={pending !== null} tabIndex={-1}>
    <header className="api-settings-heading">
      <span className="api-settings-icon" aria-hidden="true"><PlugZap size={21} strokeWidth={1.6} /></span>
      <div className="api-settings-heading-copy"><h2 id={`${id}-title`}>大模型</h2></div>
      <span className="api-settings-status">{pending === 'load' ? <Loader2 size={12} className="api-settings-spin" /> : <span aria-hidden="true" />}{loadError ? '读取失败' : status}</span>
    </header>

    {loadError ? <div className="api-settings-load-error" role="alert"><CircleAlert size={18} /><div><strong>暂时无法读取配置</strong><p>{loadError}</p></div><button type="button" className="api-settings-button api-settings-button-secondary" disabled={pending !== null} onClick={reload}><RotateCcw size={14} />重新加载</button></div> : <>
      <div className="api-settings-context"><span>OpenAI 兼容</span>{connection?.source !== 'none' && connection?.configured && <span>{source}</span>}</div>
      <form className="api-settings-form" onSubmit={event => void perform('save', event)} noValidate>
        <fieldset disabled={disabled}>
          <legend className="api-settings-sr-only">大模型连接信息</legend>
          <div className="api-settings-fields">
            <div className="api-settings-field api-settings-field-url"><label htmlFor={`${id}-url`}>Base URL</label><input ref={baseUrlInput} id={`${id}-url`} name="modelBaseUrl" type="url" inputMode="url" spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={event => updateDraft({ baseUrl: event.target.value })} aria-describedby={fieldErrors.baseUrl ? `${id}-url-error` : undefined} aria-invalid={!!fieldErrors.baseUrl} />{fieldErrors.baseUrl && <p className="api-settings-field-error" id={`${id}-url-error`}>{fieldErrors.baseUrl}</p>}</div>
            <div className="api-settings-field"><label htmlFor={`${id}-model`}>模型名称</label><input ref={modelInput} id={`${id}-model`} name="modelName" spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder="填写可用的模型 ID" value={draft.modelName} onChange={event => updateDraft({ modelName: event.target.value })} aria-describedby={fieldErrors.modelName ? `${id}-model-error` : undefined} aria-invalid={!!fieldErrors.modelName} />{fieldErrors.modelName && <p className="api-settings-field-error" id={`${id}-model-error`}>{fieldErrors.modelName}</p>}</div>
          </div>
          <div className="api-settings-field api-settings-key-field"><div className="api-settings-label-row"><label htmlFor={`${id}-key`}>API Key</label>{connection?.hasSecret && <span className="api-settings-key-saved"><Check size={12} />已保存密钥</span>}</div><div className="api-settings-key-input"><KeyRound size={15} aria-hidden="true" /><input ref={attachSecretInput} id={`${id}-key`} name="modelApiKey" type={showSecret ? 'text' : 'password'} spellCheck={false} autoCapitalize="none" autoComplete="new-password" placeholder={connection?.hasSecret ? '留空以保留已保存的密钥' : '输入你的 API Key'} onChange={event => { if (busy.current) return; setHasNewSecret(event.target.value.length > 0); setFieldErrors({}); setFeedback(null); }} aria-describedby={`${id}-key-help${fieldErrors.secret ? ` ${id}-key-error` : ''}`} aria-invalid={!!fieldErrors.secret} /><button type="button" className="api-settings-key-toggle" onClick={() => { if (!busy.current) setShowSecret(current => !current); }} disabled={!hasNewSecret || disabled} aria-label={showSecret ? '隐藏新输入的 API Key' : '显示新输入的 API Key'} aria-pressed={showSecret}>{showSecret ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><p id={`${id}-key-help`} className="api-settings-help">{hasNewSecret ? '保存后替换原密钥' : '密钥不回显，留空保留已存密钥'}</p>{fieldErrors.secret && <p className="api-settings-field-error" id={`${id}-key-error`}>{fieldErrors.secret}</p>}</div>
          <div className="api-settings-enable-row"><div><label id={`${id}-enabled-label`} htmlFor={`${id}-enabled`}>启用模型调用</label></div><button type="button" id={`${id}-enabled`} className="api-settings-switch" role="switch" aria-checked={draft.enabled} aria-labelledby={`${id}-enabled-label`} onClick={() => updateDraft({ enabled: !draft.enabled })}><span /></button></div>
        </fieldset>

        {connection && !storageReady && <div className="api-settings-feedback api-settings-feedback-info" role="status"><CircleAlert size={16} /><p>配置保存服务尚未就绪，请联系维护者后重试。</p></div>}
        {feedback && <div className={`api-settings-feedback api-settings-feedback-${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>{feedback.type === 'error' ? <CircleAlert size={16} /> : feedback.type === 'success' ? <CheckCircle2 size={16} /> : <Check size={16} />}<p>{feedback.message}{feedback.latencyMs !== undefined && <span className="api-settings-latency">耗时 {feedback.latencyMs.toLocaleString('zh-CN')} ms</span>}</p></div>}
        {conflict && <button className="api-settings-reload" type="button" disabled={pending !== null} onClick={reload}><RotateCcw size={13} />放弃未保存内容，重新加载最新配置</button>}

        <footer className="api-settings-actions"><span className="api-settings-draft-status">{pending === 'test' ? '正在验证当前表单的实际响应…' : pending === 'save' ? '正在保存配置…' : pending === 'remove' ? '正在恢复默认配置…' : dirty ? '有未保存的修改' : connection?.updatedAt ? '配置已保存' : '测试连接不会自动保存'}</span><div><button type="button" className="api-settings-button api-settings-button-secondary" disabled={disabled || !storageReady} onClick={() => void perform('test')}>{pending === 'test' ? <Loader2 size={15} className="api-settings-spin" /> : <ArrowUpRight size={15} />}测试连接</button><button type="submit" className="api-settings-button api-settings-button-primary" disabled={disabled || !storageReady || !dirty}>{pending === 'save' ? <Loader2 size={15} className="api-settings-spin" /> : <Check size={15} />}保存</button></div></footer>
      </form>
      <div className="api-settings-scope"><ShieldCheck size={14} aria-hidden="true" /><p>仅当前账户生效。{connection?.source === 'account' && <button type="button" disabled={disabled || !storageReady} onClick={() => void perform('remove')} title="移除当前账户的覆盖配置，恢复部署默认值">恢复默认配置</button>}</p></div>
    </>}
  </section>;
}
