import { useEffect } from "react";

export function usePointerReactiveGrid(active = true): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const onMove = (e: PointerEvent | MouseEvent) => {
      root.style.setProperty("--bx-pointer-x", `${e.clientX}px`);
      root.style.setProperty("--bx-pointer-y", `${e.clientY}px`);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [active]);
}
