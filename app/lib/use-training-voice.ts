'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { createBrowserVoiceEnvironment, createTrainingVoiceController, initialVoiceSnapshot } from './training-voice.ts';

type VoiceController = ReturnType<typeof createTrainingVoiceController>;

export function useTrainingVoice({ onTranscript }: { onTranscript: (text: string) => void }) {
  const controllerRef = useRef<VoiceController | null>(null);
  const transcriptRef = useRef(onTranscript);
  const listeners = useRef(new Set<() => void>());

  useEffect(() => { transcriptRef.current = onTranscript; }, [onTranscript]);

  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  const getSnapshot = useCallback(() => controllerRef.current?.getSnapshot() ?? initialVoiceSnapshot, []);
  const getServerSnapshot = useCallback(() => initialVoiceSnapshot, []);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    const controller = createTrainingVoiceController({
      environment: createBrowserVoiceEnvironment(),
      onTranscript: text => transcriptRef.current(text),
    });
    controllerRef.current = controller;
    const notify = () => { for (const listener of listeners.current) listener(); };
    const unsubscribe = controller.subscribe(notify);
    const onVisibilityChange = () => { if (document.hidden) controller.stopAll(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    notify();
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribe();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  const startListening = useCallback(() => { controllerRef.current?.startListening(); }, []);
  const stopListening = useCallback(() => { controllerRef.current?.stopListening(); }, []);
  const cancelListening = useCallback(() => { controllerRef.current?.cancelListening(); }, []);
  const speak = useCallback((text: string) => { controllerRef.current?.speak(text); }, []);
  const stopSpeaking = useCallback(() => { controllerRef.current?.stopSpeaking(); }, []);
  const stopAll = useCallback(() => { controllerRef.current?.stopAll(); }, []);
  const setVoice = useCallback((id: string) => { controllerRef.current?.setVoice(id); }, []);
  const setRate = useCallback((rate: number) => { controllerRef.current?.setRate(rate); }, []);
  const clearError = useCallback(() => { controllerRef.current?.clearError(); }, []);

  return { ...snapshot, startListening, stopListening, cancelListening, speak, stopSpeaking, stopAll, setVoice, setRate, clearError };
}
