import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** How close to the bottom still counts as "following" the stream. */
const THRESHOLD_PX = 48;

/**
 * Auto-scroll a container while the user is at the bottom; stop as soon as
 * they scroll up, and hand back `atBottom` so the view can offer a
 * "jump to bottom" button. `dep` is whatever changes when content grows.
 */
export function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null);
  const stuck = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD_PX;
    stuck.current = bottom;
    setAtBottom(bottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuck.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [dep]);

  return { ref, onScroll, atBottom, scrollToBottom };
}
