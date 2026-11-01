'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult, WorkbenchState } from './types';

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
    try{return await fetch(url,{...init,signal:controller.signal});}finally{requests.current.delete(controller);}
  },[]);
  // Keep role changes and writes in one order, including slow model requests.
  // A response from the previous role must never replace the new projection.
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const accept = useCallback((next: WorkbenchState) => { if(disposed.current||stateRef.current?.role===next.role&&stateRef.current.revision>next.revision)return;stateRef.current = next; setState(next); setError(null); }, []);
  const reload = useCallback(async () => {
    const previous=stateRef.current;
    try {
      const response = await request('/api/workbench', { cache: 'no-store', credentials: 'same-origin' });
      const body = await response.json() as WorkbenchState & { error?: string };
      if (!response.ok) throw new Error(body.error || '工作台暂时未能加载，请重试');
      if(stateRef.current===previous)accept(body as WorkbenchState);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '网络连接失败，请重试'); throw cause; }
    finally { setLoading(false); }
  }, [accept,request]);
  useEffect(() => { void Promise.resolve().then(reload).catch(() => {}); }, [reload]);
  const mutate = useCallback((action: string, payload: Record<string, unknown> = {}): Promise<ApiResult> => {
    const perform = async () => {
      const response = await request('/api/workbench', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload, revision: stateRef.current?.revision }) });
      const result = await response.json() as ApiResult & { error?: string };
      if (!response.ok) { if (response.status === 409) await reload(); throw new Error(result.error || '这次操作没有完成，请稍后重试'); }
      accept(result.state); return result;
    };
    const result = mutationQueue.current.then(perform, perform);
    mutationQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }, [accept, reload, request]);
  const uploadFollowup = useCallback((dealId: string, text: string, audio: File): Promise<ApiResult> => {
    const perform = async () => {
      const form = new FormData();
      form.set('dealId', dealId); form.set('text', text); form.set('audio', audio);
      form.set('revision', String(stateRef.current?.revision ?? ''));
      const response = await request('/api/deal-recordings', { method: 'POST', credentials: 'same-origin', body: form });
      const result = await response.json() as ApiResult & { error?: string };
      if (!response.ok) { if (response.status === 409) await reload(); throw new Error(result.error || '录音未能保存，请稍后重试'); }
      accept(result.state); return result;
    };
    const result = mutationQueue.current.then(perform, perform);
    mutationQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }, [accept, reload, request]);
  return { state, loading, error, mutate, reload, uploadFollowup };
}
