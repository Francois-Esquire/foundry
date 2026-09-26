import type { MapPoint } from "./atmosphere";
import type { Territory } from "./types";

export function createAtmosphereLayer(
  host: HTMLElement,
  project: (point: MapPoint) => MapPoint,
  ocean?: {
    strength: () => number;
    update: (time: number, enabled: boolean) => void;
    running?: () => boolean;
  }
) {
  const canvas = document.createElement("canvas");
  canvas.className = "atlas-atmosphere";
  canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas rendering is unavailable.");
  }
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let enabled = true;
  let visible = true;
  let territory: Territory | null = null;
  let opacity = 0;
  let target = 0;
  let frame = 0;
  let timer = 0;
  let last = 0;
  let cooldown = 0;
  let elapsed = 6000;
  let manualTime: number | null = null;
  let painted = 0;
  let wind: { path: MapPoint[]; began: number } | null = null;
  const draw = () => {
    const ratio = Math.min(devicePixelRatio, 2);
    const width = Math.round(host.clientWidth * ratio),
      height = Math.round(host.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.resetTransform();
    ctx.clearRect(0, 0, width, height);
    ctx.scale(ratio, ratio);
    if (!visible || document.hidden) {
      return;
    }
    ocean?.update(manualTime ?? (motion.matches ? 8000 : elapsed), enabled);
    if (!enabled) {
      return;
    }
    if (territory && opacity > 0.005) {
      const island = territory;
      ctx.beginPath();
      for (const polygon of territory.coast) {
        for (const ring of polygon) {
          ring.forEach(([x, y], i) => {
            const p = project({ x: island.x + x, y: island.y + y });
            if (i) {
              ctx.lineTo(p.x, p.y);
            } else {
              ctx.moveTo(p.x, p.y);
            }
          });
          ctx.closePath();
        }
      }
      for (const [width, alpha] of [
        [12, 0.08],
        [7, 0.16],
        [2, 0.6],
      ] as const) {
        ctx.strokeStyle = `rgba(190, 132, 48, ${alpha * opacity})`;
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }
    if (wind) {
      const t = Math.min(1, (performance.now() - wind.began) / 2400);
      ctx.strokeStyle = `rgba(117, 102, 73, ${Math.sin(t * Math.PI) * 0.55})`;
      ctx.lineWidth = 0.85;
      ctx.lineCap = "round";
      const end = Math.floor(Math.min(1, t * 1.7) * 40);
      const start = Math.floor(Math.max(0, (t - 0.45) / 0.55) * 40);
      for (const offset of [-4, 0, 4]) {
        ctx.beginPath();
        wind.path.slice(start, end + 1).forEach((point, i) => {
          const p = project(point);
          if (i) {
            ctx.lineTo(p.x, p.y + offset);
          } else {
            ctx.moveTo(p.x, p.y + offset);
          }
        });
        ctx.stroke();
      }
    }
  };
  const tick = (now: number) => {
    const step = Math.min(1, (now - last) / 180);
    if (manualTime === null) {
      elapsed += now - last;
    }
    last = now;
    opacity += (target - opacity) * step;
    if (Math.abs(target - opacity) < 0.01) {
      opacity = target;
    }
    if (wind && now - wind.began >= 2400) {
      wind = null;
    }
    if (now - painted >= 32) {
      draw();
      painted = now;
    }
    frame =
      opacity !== target ||
      wind ||
      (ocean &&
        ocean.strength() > 0 &&
        ocean.running?.() !== false &&
        !motion.matches &&
        manualTime === null)
        ? requestAnimationFrame(tick)
        : 0;
  };
  const start = () => {
    if (!frame && enabled && visible && !document.hidden) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  const cancelWind = () => {
    clearTimeout(timer);
    timer = 0;
    wind = null;
  };
  const highlight = (next: Territory | null) => {
    if (next?.id === territory?.id && target === (next ? 1 : 0)) {
      return;
    }
    cancelWind();
    if (next) {
      if (territory?.id !== next.id) {
        opacity = 0;
      }
      territory = next;
    }
    target = next ? 1 : 0;
    if (motion.matches) {
      opacity = target;
      draw();
    } else {
      start();
    }
  };
  const stop = () => {
    cancelWind();
    cancelAnimationFrame(frame);
    frame = 0;
    opacity = target;
    draw();
  };
  const visibility = () => {
    stop();
    if (
      !motion.matches &&
      manualTime === null &&
      ocean &&
      ocean.strength() > 0 &&
      ocean.running?.() !== false
    ) {
      start();
    }
  };
  const preference = () => {
    visibility();
  };
  document.addEventListener("visibilitychange", visibility);
  motion.addEventListener("change", preference);
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    visibility();
  });
  observer.observe(host);
  return {
    cameraChanged: () => {
      cancelWind();
      draw();
      if (
        !motion.matches &&
        manualTime === null &&
        ocean &&
        ocean.running?.() !== false &&
        ocean.strength() > 0
      ) {
        start();
      }
    },
    dispose: () => {
      cancelWind();
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", preference);
      observer.disconnect();
      canvas.remove();
    },
    highlight,
    setCurrentTime: (milliseconds: number | null) => {
      if (
        milliseconds !== null &&
        (!Number.isFinite(milliseconds) || milliseconds < 0)
      ) {
        return;
      }
      manualTime = milliseconds;
      if (milliseconds !== null) {
        elapsed = milliseconds;
      }
      visibility();
    },
    setEnabled: (value: boolean) => {
      enabled = value;
      visibility();
    },
    wind: (makePath: (() => MapPoint[] | null) | null) => {
      clearTimeout(timer);
      timer = 0;
      if (
        !(makePath && enabled && visible) ||
        motion.matches ||
        document.hidden ||
        wind ||
        performance.now() < cooldown
      ) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = 0;
        const path = makePath();
        if (!path) {
          return;
        }
        wind = { began: performance.now(), path };
        cooldown = performance.now() + 12_000;
        start();
      }, 1000);
    },
  };
}
