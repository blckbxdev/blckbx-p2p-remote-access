import { useEffect, useRef } from "react";

export function SpinningCube() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const maybeBrush = canvas.getContext("2d");
    if (!maybeBrush) return;
    const brush: CanvasRenderingContext2D = maybeBrush;

    let dims = { w: 0, h: 0, cx: 0, cy: 0 };
    const scale = 30;
    let t = 0;
    let frame = 0;
    let last = performance.now();
    const spinSpeed = 0.48;

    const refreshDims = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = wrap.getBoundingClientRect();
      const rw = Math.max(1, rect.width);
      const rh = Math.max(1, rect.height);
      canvas.width = Math.floor(rw * dpr);
      canvas.height = Math.floor(rh * dpr);
      canvas.style.width = `${rw}px`;
      canvas.style.height = `${rh}px`;
      brush.setTransform(1, 0, 0, 1, 0, 0);
      brush.scale(dpr, dpr);
      dims = { w: rw, h: rh, cx: rw / 2, cy: rh / 2 };
    };

    refreshDims();
    const ro = new ResizeObserver(refreshDims);
    ro.observe(wrap);

    function rotate(x: number, y: number, z: number) {
      const c1 = Math.cos(t);
      const s1 = Math.sin(t);
      const c2 = Math.cos(t * 0.7);
      const s2 = Math.sin(t * 0.7);
      const x1 = x * c1 - z * s1;
      const z1 = x * s1 + z * c1;
      const y2 = y * c2 - z1 * s2;
      const z2 = y * s2 + z1 * c2;
      return [x1, y2, z2] as const;
    }

    function project(x: number, y: number, z: number) {
      const perspective = 100 / (100 + z + 100);
      return [dims.cx + x * perspective, dims.cy + y * perspective] as const;
    }

    function getIdx(x: number, y: number, z: number) {
      return (x + 1) * 9 + (y + 1) * 3 + (z + 1);
    }

    function drawWirePath(projected: ReadonlyArray<readonly [number, number]>) {
      brush.beginPath();
      for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
          for (let z = -1; z <= 1; z++) {
            const currIdx = getIdx(x, y, z);
            const p1 = projected[currIdx];
            if (x < 1) {
              const p2 = projected[getIdx(x + 1, y, z)];
              brush.moveTo(p1[0], p1[1]);
              brush.lineTo(p2[0], p2[1]);
            }
            if (y < 1) {
              const p3 = projected[getIdx(x, y + 1, z)];
              brush.moveTo(p1[0], p1[1]);
              brush.lineTo(p3[0], p3[1]);
            }
            if (z < 1) {
              const p4 = projected[getIdx(x, y, z + 1)];
              brush.moveTo(p1[0], p1[1]);
              brush.lineTo(p4[0], p4[1]);
            }
          }
        }
      }
    }

    function draw(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += spinSpeed * dt;

      brush.clearRect(0, 0, dims.w, dims.h);
      brush.lineCap = "round";
      brush.lineJoin = "round";

      const points: [number, number, number][] = [];
      for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
          for (let z = -1; z <= 1; z++) {
            points.push([x * scale, y * scale, z * scale]);
          }
        }
      }

      const projected = points.map((p) => {
        const r = rotate(p[0], p[1], p[2]);
        return project(r[0], r[1], r[2]);
      });

      brush.strokeStyle = "#000000";
      brush.lineWidth = 4.2;
      drawWirePath(projected);
      brush.stroke();

      brush.strokeStyle = "#ffffff";
      brush.lineWidth = 1.8;
      drawWirePath(projected);
      brush.stroke();

      frame = requestAnimationFrame(draw);
    }

    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="h-full w-full min-h-[120px] min-w-[120px]">
      <canvas ref={canvasRef} className="block h-full w-full opacity-95" aria-hidden />
    </div>
  );
}
