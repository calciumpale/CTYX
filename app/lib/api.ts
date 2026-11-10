'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult, WorkbenchState } from './types';

function incompleteResponse(response: Response): Error {
  if (response.redirected || response.status === 401) return new Error('工作台登录状态可能已失效，请刷新页面后重试。');
  const status = !response.ok && response.status > 0 ? `（HTTP ${response.status}）` : '';
  return new Error(`工作台未返回完整响应${status}，请稍后重试。`);
}

export async function readWorkbenchResponse<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown;
  try { body = await response.json(); }
  catch { throw incompleteResponse(response); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw incompleteResponse(response);
  if (!response.ok) {
    const error = 'error' in body && typeof body.error === 'string' && body.error.trim();
    throw new Error(error || fallback);
  }
  return body as T;
}

export function useWorkbench() {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<WorkbenchState | null>(null);
  const disposed=useRef(false);
  const requests=useRef(new Set<AbortController>());
  useEffect(()=>{disposed.current=false;const activeRequests=requests.current;return()=>{disposed.current=true;for(const controller of activeRequests)controller.abort();activeRequests.clear();};},[]);
  const request=useCallback(async(url:string,init:RequestInit={})=>{
    if(disposed.current)throw new DOMException('当前账号已退出','AbortError');
    const controller=new AbortController();requests.current.add(controller);
    try { return await fetch(url, { ...init, signal: controller.signal }); }
    catch {
      if (controller.signal.aborted) throw new DOMException('当前账号已退出', 'AbortError');
      throw new Error('暂时无法连接工作台，请检查网络后重试。');
    } finally { requests.current.delete(controller); }
  },[]);
  // Keep role changes and writes in one order, including slow model requests.
  // A response from the previous role must never replace the new projection.
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const accept = useCallback((next: WorkbenchState) => { if(disposed.current||stateRef.current?.role===next.role&&stateRef.current.revision>next.revision)return;stateRef.current = next; setState(next); setError(null); }, []);
  const reload = useCallback(async () => {
    const previous=stateRef.current;
    try {
      const response = await request('/api/workbench', { cache: 'no-store', credentials: 'same-origin' });
      const body = await readWorkbenchResponse<WorkbenchState>(response, '工作台暂时未能加载，请重试。');
      if (!Number.isSafeInteger(body.revision)) throw incompleteResponse(response);
      if(stateRef.current===previous)accept(body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '网络连接失败，请重试'); throw cause; }
    finally { setLoading(false); }
  }, [accept,request]);
  useEffect(() => { void Promise.resolve().then(reload).catch(() => {}); }, [reload]);
  const acceptMutation = useCallback(async (response: Response, fallback: string) => {
    const result = await readWorkbenchResponse<ApiResult>(response, fallback).catch(async error => {
      // A refresh can resolve a stale revision, but must not replace the original error.
      if (response.status === 409) await reload().catch(() => {});
      throw error;
    });
    if (!Number.isSafeInteger(result.state?.revision)) throw incompleteResponse(response);
    accept(result.state);
    return result;
  }, [accept, reload]);
  const mutate = useCallback((action: string, payload: Record<string, unknown> = {}): Promise<ApiResult> => {
    const perform = async () => {
      const response = await request('/api/workbench', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload, revision: stateRef.current?.revision }) });
      return acceptMutation(response, '这次操作没有完成，请稍后重试。');
    };
    const result = mutationQueue.current.then(perform, perform);
    mutationQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }, [acceptMutation, request]);
  const uploadFollowup = useCallback((dealId: string, text: string, audio: File): Promise<ApiResult> => {
    const perform = async () => {
      const form = new FormData();
      form.set('dealId', dealId); form.set('text', text); form.set('audio', audio);
      form.set('revision', String(stateRef.current?.revision ?? ''));
      const response = await request('/api/deal-recordings', { method: 'POST', credentials: 'same-origin', body: form });
      return acceptMutation(response, '录音未能保存，请稍后重试。');
    };
    const result = mutationQueue.current.then(perform, perform);
    mutationQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }, [acceptMutation, request]);
  return { state, loading, error, mutate, reload, uploadFollowup };
}
