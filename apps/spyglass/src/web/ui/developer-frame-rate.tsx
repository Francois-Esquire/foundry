import "./developer-frame-rate.css";
import { useEffect, useState } from "react";
import type { AppBarContext } from "./chrome-entries";

/** Count submitted map frames, including periods when the scene draws nothing. */
function useFrameRate() {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") {
      return;
    }
    let frames = 0;
    let start = performance.now();
    const observer = new PerformanceObserver((list) => {
      if (!document.hidden) {
        frames += list.getEntriesByName("spyglass:render-submit").length;
      }
    });
    observer.observe({ entryTypes: ["measure"] });
    const reset = () => {
      observer.takeRecords();
      frames = 0;
      start = performance.now();
      setFps(null);
    };
    document.addEventListener("visibilitychange", reset);
    const timer = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      const now = performance.now();
      setFps(Math.round((frames * 1000) / (now - start)));
      frames = 0;
      start = now;
    }, 1000);
    return () => {
      clearInterval(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", reset);
    };
  }, []);
  return fps;
}

/** Visible in the app bar even when settings are closed. */
export default function DeveloperFrameRate({ onOpen }: AppBarContext) {
  const fps = useFrameRate();
  return (
    <button
      aria-controls="spyglass-sidebar"
      aria-haspopup="dialog"
      aria-label="Open development tools"
      className="spyglass-fps"
      onClick={onOpen}
      title="Map frames submitted per second; zero while idle. Open development tools."
      type="button"
    >
      <span>{fps ?? "–"}</span>
      <small>FPS</small>
    </button>
  );
}
