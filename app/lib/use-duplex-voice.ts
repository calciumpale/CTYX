'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { createBrowserDuplexVoiceEnvironment, createDuplexVoiceController, initialDuplexVoiceSnapshot } from './duplex-voice.ts';
import type { DuplexVoiceFinal } from './duplex-voice.ts';

type Controller = ReturnType<typeof createDuplexVoiceController>;

export function useDuplexVoice({ onFinal }: { onFinal: (final: DuplexVoiceFinal) => void }) {
  const controllerRef = useRef<Controller | null>(null);
  const finalRef = useRef(onFinal);
  const listeners = useRef(new Set<() => void>());
  useEffect(() => { finalRef.current = onFinal; }, [onFinal]);

  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  const getSnapshot = useCallback(() => controllerRef.current?.getSnapshot() ?? initialDuplexVoiceSnapshot, []);
  const getServerSnapshot = useCallback(() => initialDuplexVoiceSnapshot, []);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    const controller = createDuplexVoiceController({
      environment: createBrowserDuplexVoiceEnvironment(), onFinal: final => finalRef.current(final),
    });
    controllerRef.current = controller;
    const notify = () => { for (const listener of listeners.current) listener(); };
    const unsubscribe = controller.subscribe(notify);
    const hidden = () => { if (document.hidden) controller.disconnect(); };
    const leave = () => controller.disconnect();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leave);
    notify();
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leave);
      unsubscribe(); controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  const connect = useCallback((sessionId: string, preferredVoice?: string) => controllerRef.current?.connect(sessionId, preferredVoice) ?? Promise.resolve(), []);
  const disconnect = useCallback(() => controllerRef.current?.disconnect(), []);
  const speak = useCallback((text: string, id: string) => controllerRef.current?.speak(text, id), []);
  const interrupt = useCallback(() => controllerRef.current?.interrupt(), []);
  const setVoice = useCallback((id: string) => controllerRef.current?.setVoice(id), []);
  const setRate = useCallback((rate: number) => controllerRef.current?.setRate(rate), []);
  const clearError = useCallback(() => controllerRef.current?.clearError(), []);
  return { ...snapshot, connect, disconnect, speak, interrupt, setVoice, setRate, clearError };
}
