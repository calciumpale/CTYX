'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { preferredScrollBehavior } from './scroll-behavior';

/** CDS scroll pin: respect manual input, including the 150 ms cooldown. */
export function useChatScroll(contentKey: string, threadKey?: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUserInput = useRef(0);
  const pinned = useRef(true);
  const previousThread = useRef(threadKey);
  const jumpTarget = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);
  const resumeFollowing = useCallback(() => {
    pinned.current = true;
    lastUserInput.current = 0;
    jumpTarget.current = null;
  }, []);
  const markUserInput = useCallback(() => {
    lastUserInput.current = performance.now();
    pinned.current = false;
    jumpTarget.current = null;
  }, []);
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.clientHeight;
    const gap = bottom - el.scrollTop;
    if (jumpTarget.current !== null) {
      if (el.scrollTop + 2 < Math.min(jumpTarget.current, bottom)) return;
      jumpTarget.current = null;
      // Streaming can extend the transcript after the native jump has started.
      if (gap > 2) el.scrollTo({ top: bottom, behavior: 'instant' });
      return;
    }
    if (performance.now() - lastUserInput.current > 150) pinned.current = gap < 40;
    setShowJump(gap > 120);
  }, []);
  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    resumeFollowing();
    const behavior = preferredScrollBehavior();
    const bottom = el.scrollHeight - el.clientHeight;
    if (behavior === 'smooth' && bottom - el.scrollTop > 2) jumpTarget.current = bottom;
    el.focus({ preventScroll: true });
    el.scrollTo({ top: bottom, behavior });
    setShowJump(false);
  }, [resumeFollowing]);
  useEffect(() => {
    if (previousThread.current !== threadKey) {
      previousThread.current = threadKey;
      resumeFollowing();
    }
    const frame = requestAnimationFrame(() => {
      const el = containerRef.current;
      if (!el || !pinned.current || jumpTarget.current !== null) return;
      el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
      setShowJump(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [contentKey, threadKey, resumeFollowing]);
  return { containerRef, markUserInput, onScroll, showJump, jumpToLatest, resumeFollowing };
}
