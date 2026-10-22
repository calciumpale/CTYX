'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResult, WorkbenchState } from './types';

export function useWorkbench() {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<WorkbenchState | null>(null);
  // Keep role changes and writes in one order, including slow model requests.
  // A response from the previous role must never replace the new projection.
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const accept = useCallback((next: WorkbenchState) => { stateRef.current = next; setState(next); setError(null); }, []);
  const reload = useCallback(async () => {
    try {
      const response = await fetch('/api/workbench', { cache: 'no-store', credentials: 'same-origin' });
      const body = await response.json() as WorkbenchState & { error?: string };
      if (!response.ok) throw new Error(body.error || '工作台暂时未能加载，请重试');
      accept(body as WorkbenchState);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '网络连接失败，请重试'); throw cause; }
    finally { setLoading(false); }
  }, [accept]);
  useEffect(() => { void Promise.resolve().then(reload).catch(() => {}); }, [reload]);
  const mutate = useCallback((action: string, payload: Record<string, unknown> = {}): Promise<ApiResult> => {
    const perform = async () => {
      const response = await fetch('/api/workbench', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload, revision: stateRef.current?.revision }) });
      const result = await response.json() as ApiResult & { error?: string };
      if (!response.ok) { if (response.status === 409) await reload(); throw new Error(result.error || '这次操作没有完成，请稍后重试'); }
      accept(result.state); return result;
    };
    const result = mutationQueue.current.then(perform, perform);
    mutationQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }, [accept, reload]);
  return { state, loading, error, mutate, reload };
}
