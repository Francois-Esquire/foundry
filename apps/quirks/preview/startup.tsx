import { useCallback, useEffect, useState } from "react";
import { SplashView } from "../src/views/splash";
import { summarizeConfig } from "../src/views/splash-model";
import { PreviewApp } from "./app";
import { dashboardSnapshot } from "./snapshot";

/** Simulated loading belongs to the preview, not the presentational splash. */
export function PreviewStartup({ onClose }: { readonly onClose: () => void }) {
  const [ready, setReady] = useState(false);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 900);
    return () => clearTimeout(timer);
  }, []);
  const enter = useCallback(() => setEntered(true), []);
  if (entered) {
    return <PreviewApp onClose={onClose} />;
  }
  return (
    <SplashView
      onClose={onClose}
      onEnter={enter}
      preview
      state={
        ready
          ? { counts: summarizeConfig(dashboardSnapshot), status: "ready" }
          : { status: "loading" }
      }
      workspace={dashboardSnapshot.workspace}
    />
  );
}
