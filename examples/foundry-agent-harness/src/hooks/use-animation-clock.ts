import { useEffect, useState } from "react";
import type { Clock } from "@/model/screen";

const FRAME_MS = 80;

export function useAnimationClock(active: boolean): Clock {
  const [clock, setClock] = useState<Clock>(() => ({
    frame: 0,
    now: Date.now(),
  }));
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(
      () =>
        setClock((current) => ({ frame: current.frame + 1, now: Date.now() })),
      FRAME_MS
    );
    return () => clearInterval(timer);
  }, [active]);
  return clock;
}
