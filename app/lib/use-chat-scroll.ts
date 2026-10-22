'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** CDS scroll pin: respect manual input, including the 150 ms cooldown. */
export function useChatScroll(contentKey: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUserInput = useRef(0);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const markUserInput = useCallback(() => {
    lastUserInput.current = performance.now();
    pinned.current = false;
  }, []);
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (performance.now() - lastUserInput.current > 150) pinned.current = gap < 40;
    setShowJump(gap > 120);
  }, []);
  const jumpToLatest = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    pinned.current = true;
    lastUserInput.current = 0;
    setShowJump(false);
  }, []);
  useEffect(() => {
    if (pinned.current && performance.now() - lastUserInput.current > 150) {
      const frame = requestAnimationFrame(jumpToLatest);
      return () => cancelAnimationFrame(frame);
    }
  }, [contentKey, jumpToLatest]);
  return { containerRef, markUserInput, onScroll, showJump, jumpToLatest };
}
