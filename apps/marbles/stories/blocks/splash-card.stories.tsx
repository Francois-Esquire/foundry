import { useCallback, useEffect, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { summarizeConfig } from "~/cli/state/splash-model";
import { SplashCard } from "~/components/blocks/splash-card";
import { Text } from "~/components/ui/text";
import type { SplashState } from "~/model/splash";
import { dashboardSnapshot } from "../fixtures/snapshot";
import { ignore, renderFrame } from "../frame";

const loading: SplashState = { status: "loading" };

const ready: SplashState = {
  counts: summarizeConfig(dashboardSnapshot),
  hasConfig: true,
  status: "ready",
};

const skipped: SplashState = {
  counts: { monitors: 0, runs: 0, schedules: 0, steps: 0, workflows: 0 },
  hasConfig: false,
  status: "ready",
};

const roomy = { height: 32, padded: false, width: 90 };
const compact = { height: 24, padded: false, width: 90 };
const short = { height: 18, padded: false, width: 90 };
const narrow = { height: 32, padded: false, width: 60 };

function Card({
  size,
  state,
}: {
  readonly size: { readonly height: number; readonly width: number };
  readonly state: SplashState;
}) {
  return (
    <SplashCard
      height={size.height}
      onEnter={ignore}
      state={state}
      width={size.width}
      workspace="foundry"
    />
  );
}

function LoadThenEnter() {
  const [state, setState] = useState<SplashState>(loading);
  const [entered, setEntered] = useState(0);
  useEffect(() => {
    if (state.status !== "loading") {
      return;
    }
    const timer = setTimeout(() => setState(ready), 1500);
    return () => clearTimeout(timer);
  }, [state]);
  const enter = useCallback(() => {
    setEntered((count) => count + 1);
    setState(loading);
  }, []);
  return (
    <>
      <SplashCard
        height={compact.height}
        onEnter={enter}
        state={state}
        width={compact.width}
        workspace="foundry"
      />
      <Text>{`Entered ${String(entered)} times`}</Text>
    </>
  );
}

export default defineStories({
  component: "SplashCard",
  description:
    "The startup card: the logo, the workspace, loading progress, and the counts it loaded.",
  title: "Blocks/SplashCard",
});

export const Loading = story({
  description: "Still loading: a spinner and placeholder counts.",
  name: "Loading",
  render: (renderer) =>
    renderFrame(renderer, <Card size={roomy} state={loading} />, roomy),
});

export const Ready = story({
  description:
    "Loaded with a source: an accent border, the counts, and the Enter action.",
  name: "Ready",
  render: (renderer) =>
    renderFrame(renderer, <Card size={roomy} state={ready} />, roomy),
});

export const SetupSkipped = story({
  description: "Ready without a source because setup was skipped.",
  name: "Setup skipped",
  render: (renderer) =>
    renderFrame(renderer, <Card size={roomy} state={skipped} />, roomy),
});

export const CompactLoading = story({
  description: "Under 26 rows the card drops its gaps and vertical padding.",
  name: "Compact, loading",
  render: (renderer) =>
    renderFrame(renderer, <Card size={compact} state={loading} />, compact),
});

export const CompactReady = story({
  description: "The compact card once loaded.",
  name: "Compact, ready",
  render: (renderer) =>
    renderFrame(renderer, <Card size={compact} state={ready} />, compact),
});

export const Short = story({
  description: "Under 20 rows the logo switches to the small font.",
  name: "Short",
  render: (renderer) =>
    renderFrame(renderer, <Card size={short} state={ready} />, short),
});

export const NarrowReady = story({
  description:
    "Under 77 columns the card narrows to the terminal and uses the small logo.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(renderer, <Card size={narrow} state={ready} />, narrow),
});

export const NarrowSkipped = story({
  description: "The narrow card when setup was skipped.",
  name: "Narrow, setup skipped",
  render: (renderer) =>
    renderFrame(renderer, <Card size={narrow} state={skipped} />, narrow),
});

export const LoadAndEnter = story({
  description:
    "Loads for a moment, then click Press Enter to enter to count a visit and load again.",
  name: "Load and enter",
  render: (renderer) => renderFrame(renderer, <LoadThenEnter />, compact),
});
