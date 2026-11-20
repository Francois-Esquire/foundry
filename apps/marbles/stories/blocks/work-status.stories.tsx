import { useCallback, useEffect, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { WorkStatus } from "~/components/blocks/work-status";
import { Action } from "~/components/ui/action";
import { theme } from "~/components/ui/theme";
import { renderFrame } from "../frame";

const size = { height: 5, width: 50 };

type Outcome = "succeed" | "fail";

function Caption({ children }: { readonly children: string }) {
  return <text fg={theme.colors.mutedForeground}>{children}</text>;
}

function LaunchJob() {
  const [running, setRunning] = useState<Outcome | undefined>();
  const [error, setError] = useState<string | undefined>();
  const start = useCallback((outcome: Outcome) => {
    setError(undefined);
    setRunning(outcome);
  }, []);
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setTimeout(() => {
      setError(
        running === "fail"
          ? "Launch failed: check-api has no input schema."
          : undefined
      );
      setRunning(undefined);
    }, 1200);
    return () => clearTimeout(timer);
  }, [running]);
  return (
    <>
      <box flexDirection="row" gap={2}>
        <Action
          id="work-status:succeed"
          label="[ Launch ]"
          onAction={start}
          value="succeed"
        />
        <Action
          id="work-status:fail"
          label="[ Launch and fail ]"
          onAction={start}
          value="fail"
        />
      </box>
      <WorkStatus
        busy={running !== undefined}
        error={error}
        label="Launching..."
      />
    </>
  );
}

export default defineStories({
  component: "WorkStatus",
  description:
    "One line below the dashboard: a label while work runs, then its error if it failed.",
  title: "Blocks/WorkStatus",
});

export const Busy = story({
  description: "Work in progress shows its label.",
  name: "Busy",
  render: (renderer) =>
    renderFrame(renderer, <WorkStatus busy label="Working…" />, size),
});

export const Failed = story({
  description: "Finished work that failed shows the error.",
  name: "Failed",
  render: (renderer) =>
    renderFrame(
      renderer,
      <WorkStatus
        busy={false}
        error="Pause failed: step write is not running."
        label="Working…"
      />,
      size
    ),
});

export const BusyOverError = story({
  description: "While work runs again, the label replaces the earlier error.",
  name: "Busy over an error",
  render: (renderer) =>
    renderFrame(
      renderer,
      <WorkStatus
        busy
        error="Pause failed: step write is not running."
        label="Waiting for schedule run…"
      />,
      size
    ),
});

export const Idle = story({
  description: "Idle work with no error renders nothing below the caption.",
  name: "Idle",
  render: (renderer) =>
    renderFrame(
      renderer,
      <>
        <Caption>Idle: nothing renders below this line.</Caption>
        <WorkStatus busy={false} label="Working…" />
      </>,
      size
    ),
});

export const Launch = story({
  description:
    "Click a launch button: the label shows for a moment, then the error if it failed.",
  name: "Launch",
  render: (renderer) => renderFrame(renderer, <LaunchJob />, size),
});
