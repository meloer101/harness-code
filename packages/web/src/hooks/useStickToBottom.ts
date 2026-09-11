import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** How close to the bottom still counts as "following" the stream. */
const THRESHOLD_PX = 48;

/**
 * Auto-scroll a container while the user is at the bottom; stop as soon as
 * they scroll up, and hand back `atBottom` so the view can offer a
 * "jump to bottom" button. `dep` is whatever changes when content grows.
 *
 * Only an upward scroll unsticks. Content growing underneath (rows sized by
 * `content-visibility` settling after layout, a tool card expanding) also
 * moves the bottom away without any user intent — a ResizeObserver on the
 * content keeps following through that instead of mistaking it for a scroll.
 */
export function useStickToBottom<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T | null>(null);
  const stuck = useRef(true);
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  const pin = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= THRESHOLD_PX;
    if (nearBottom) stuck.current = true;
    else if (el.scrollTop < lastTop.current - 1) stuck.current = false;
    lastTop.current = el.scrollTop;
    setAtBottom(nearBottom || stuck.current);
  }, []);

  const scrollToBottom = useCallback(() => {
    stuck.current = true;
    setAtBottom(true);
    pin();
  }, [pin]);

  useLayoutEffect(() => {
    if (stuck.current) pin();
  }, [dep, pin]);

  useEffect(() => {
    const el = ref.current;
    const content = el?.firstElementChild;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stuck.current) pin();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [pin]);

  return { ref, onScroll, atBottom, scrollToBottom };
}
