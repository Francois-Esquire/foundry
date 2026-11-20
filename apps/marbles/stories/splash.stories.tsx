import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { SplashView } from "~/cli/views/splash";
import type { SplashState } from "~/model/splash";
import { renderReactStory } from "./render-react-story";

const ready: SplashState = {
  counts: { monitors: 2, runs: 3, schedules: 1, steps: 1, workflows: 3 },
  hasConfig: true,
  status: "ready",
};

const stayOnSplash = () => undefined;

function ReadySplash() {
  const [visit, setVisit] = useState(0);
  const reset = useCallback(() => setVisit((previous) => previous + 1), []);

  return (
    <SplashView
      key={visit}
      onClose={reset}
      onEnter={stayOnSplash}
      state={ready}
      workspace="foundry"
    />
  );
}

export default defineStories({ title: "Splash" });

export const Ready = story({
  description: "A loaded workspace, ready to enter.",
  name: "Ready",
  render: (renderer) => renderReactStory(renderer, <ReadySplash />),
});
