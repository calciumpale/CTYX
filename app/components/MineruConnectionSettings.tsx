'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, ExternalLink, FileScan, Loader2, ShieldCheck } from 'lucide-react';
import type { MineruConnectionSnapshot } from '../lib/mineru-store';
import './company-connection.css';

type ConnectionCommand = { action: 'save'; version: number; token: string } | { action: 'remove'; version: number };

export function MineruConnectionSettings() {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef<AbortController | null>(null);
  const [connection, setConnection] = useState<MineruConnectionSnapshot | null>(null);
  const [pending, setPending] = useState<'load' | 'save' | 'remove' | null>('load');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const request = useCallback(async (command?: ConnectionCommand) => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(command?.action ?? 'load');
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/mineru-connection', {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(command ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) } : {}),
      });
      const data = await response.json().catch(() => null) as (MineruConnectionSnapshot & { error?: string }) | null;
      if (!response.ok || typeof data?.configured !== 'boolean') throw new Error(data?.error || '暂时无法读取 MinerU 配置，请重试。');
      if (controller.signal.aborted) return;
      setConnection(data);
      if (command) {
        if (input.current) input.current.value = '';
        setMessage(command.action === 'save' ? 'MinerU API Token 已保存。' : data.source === 'environment' ? '已移除工作区 Token，当前使用服务端配置。' : 'MinerU API Token 已移除。');
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'MinerU 配置暂时不可用，请重试。');
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(null);
      }
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) void request(); });
    return () => {
      mounted = false;
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [request]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection) return;
    void request({ action: 'save', version: connection.version, token: input.current?.value ?? '' });
  }

  const status = pending === 'load' ? '读取中' : connection?.configured
    ? connection.source === 'environment' ? '使用服务端配置' : '已配置'
    : connection ? '未配置' : '读取失败';
  return <section className="company-connection" id="mineru-configuration" aria-labelledby={`${id}-title`} aria-busy={pending !== null}>
    <div className="company-connection-heading"><FileScan size={23} aria-hidden="true"/><div><h2 id={`${id}-title`}>文档解析 · MinerU</h2></div><span>{status}</span></div>
    <p className="company-connection-description">连接后，知识库导入 PDF 时可选择 MinerU 云解析。选用时会将原 PDF 发送到 MinerU。</p>
    {pending === 'load' && !connection && <p className="company-connection-feedback"><Loader2 size={15} className="spin"/>正在读取配置…</p>}
    {connection && <>
      <form onSubmit={save}>
        <fieldset disabled={pending !== null || !connection.storageReady}>
          <div className="company-connection-fields"><label htmlFor={`${id}-token`}>MinerU API Token<input ref={input} id={`${id}-token`} type="password" autoComplete="new-password" maxLength={8192} placeholder={connection.source === 'account' ? '已保存，输入新 Token 可更换' : '输入 MinerU API Token'} required/></label></div>
          <div className="company-connection-actions company-connection-footer"><span><ShieldCheck size={14} aria-hidden="true"/>Token 加密保存</span><button type="submit" className="button primary">{pending === 'save' && <Loader2 size={15} className="spin"/>}保存</button></div>
        </fieldset>
      </form>
      {!connection.storageReady && <p className="company-connection-feedback" role="alert">加密存储尚未启用，请联系管理员。</p>}
    </>}
    {error && <div className="company-connection-feedback" role="alert"><CircleAlert size={16}/><span>{error}</span><button type="button" className="text-button" disabled={pending !== null} onClick={() => void request()}>重新加载</button></div>}
    {message && <p className="company-connection-feedback" role="status"><Check size={16}/>{message}</p>}
    <div className="company-connection-footer"><a href="https://mineru.net/apiManage/docs" target="_blank" rel="noopener noreferrer">查看 MinerU API 文档<ExternalLink size={13}/></a>{connection?.source === 'account' && <button type="button" className="text-button" disabled={pending !== null || !connection.storageReady} onClick={() => void request({ action: 'remove', version: connection.version })}>{pending === 'remove' ? '移除中…' : '移除 Token'}</button>}</div>
  </section>;
}
