import { type RefObject, useEffect, useState } from "react";

/** Largest square that fits in `container` (for chessground sizing). */
export function useBoardSquareSize(containerRef: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize(Math.max(0, Math.floor(Math.min(width, height))));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  return size;
}
