import { useCallback, useEffect, useState } from "react";
import { ConfigErrorView } from "../src/views/config-error";
import { OnboardingView } from "../src/views/onboarding";
import { SplashView } from "../src/views/splash";
import { summarizeConfig } from "../src/views/splash-model";
import { PreviewApp } from "./app";
import { dashboardSnapshot } from "./snapshot";

/** Simulated loading belongs to the preview, not the presentational splash. */
export function PreviewStartup({ onClose }: { readonly onClose: () => void }) {
  const [setup, setSetup] = useState(
    process.argv.includes("--setup") ||
      process.argv.includes("--setup-error") ||
      process.argv.includes("--load-error")
  );
  const finishSetup = useCallback(() => {
    setSetup(false);
    return Promise.resolve();
  }, []);
  const create = useCallback(() => {
    if (process.argv.includes("--setup-error")) {
      return Promise.reject(
        new Error("Preview: config already exists. It was not overwritten.")
      );
    }
    if (process.argv.includes("--load-error")) {
      return Promise.reject(
        new Error(
          "Preview: config was created but could not load. Fix it and restart."
        )
      );
    }
    return finishSetup();
  }, [finishSetup]);
  const [ready, setReady] = useState(false);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 900);
    return () => clearTimeout(timer);
  }, []);
  const enter = useCallback(() => setEntered(true), []);
  if (process.argv.includes("--config-error")) {
    return (
      <ConfigErrorView
        message="Preview: quirks.config.ts could not load. Check its imports and syntax."
        onClose={onClose}
      />
    );
  }
  if (setup) {
    return (
      <OnboardingView
        onClose={onClose}
        onCreate={create}
        onSkip={finishSetup}
        path="./quirks.config.ts (preview only)"
      />
    );
  }
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
