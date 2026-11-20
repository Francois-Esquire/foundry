import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { SplashView } from "~/cli/views/splash";
import type { SplashState } from "~/model/splash";
import { ignore, renderFrame } from "../frame";
import { renderReactStory } from "../render-react-story";
import { ReplayKeys } from "./replay-keys";

const ready: SplashState = {
  counts: { monitors: 2, runs: 3, schedules: 1, steps: 1, workflows: 3 },
  hasConfig: true,
  status: "ready",
};

const noConfig: SplashState = {
  counts: { monitors: 0, runs: 0, schedules: 0, steps: 0, workflows: 0 },
  hasConfig: false,
  status: "ready",
};

const loading: SplashState = { status: "loading" };

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

export default defineStories({
  component: "SplashView",
  description: "The startup screen: the splash card over the sparkle field.",
  title: "Views/Splash",
});

export const Ready = story({
  description: "A loaded workspace, ready to enter.",
  name: "Ready",
  render: (renderer) => renderReactStory(renderer, <ReadySplash />),
});

export const Loading = story({
  description: "Marbles is still loading; Enter does nothing yet.",
  name: "Loading",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <SplashView
        onClose={ignore}
        onEnter={ignore}
        state={loading}
        workspace="foundry"
      />
    ),
});

export const NoConfig = story({
  description: "Setup was skipped, so there is no source and nothing counted.",
  name: "No config",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <SplashView
        onClose={ignore}
        onEnter={ignore}
        state={noConfig}
        workspace="foundry"
      />
    ),
});

export const Quitting = story({
  description: "q opens the quit dialog and pauses the field.",
  name: "Quit dialog",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <ReplayKeys replay={{ keys: ["q"], shows: "Quit Marbles?" }}>
        <SplashView
          onClose={ignore}
          onEnter={ignore}
          state={ready}
          workspace="foundry"
        />
      </ReplayKeys>
    ),
});

export const Small = story({
  description:
    "A 60 by 18 terminal: the card drops to the small logo and packs tighter.",
  name: "Small terminal",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SplashView
        onClose={ignore}
        onEnter={ignore}
        state={ready}
        workspace="foundry"
      />,
      { height: 18, padded: false, width: 60 }
    ),
});
