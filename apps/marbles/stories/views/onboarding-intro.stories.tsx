import { defineStories, story } from "textbook-sh";
import {
  ProviderOnboarding,
  WorkspaceWelcome,
} from "~/cli/views/onboarding-intro";
import { ignore } from "../frame";
import { renderReactStory } from "../render-react-story";
import { type Replay, ReplayKeys } from "./replay-keys";

type Review = Parameters<typeof ProviderOnboarding>[0]["review"];

const detected: Review = {
  configured: false,
  offered: [
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
  ],
  reserved: [],
};

const configured: Review = {
  configured: true,
  offered: [],
  reserved: [],
};

const none: Review = {
  configured: false,
  offered: [],
  reserved: [],
};

const reserved: Review = {
  configured: false,
  offered: [{ id: "claude", label: "Claude Code" }],
  reserved: [
    {
      enabled: true,
      id: "codex",
      plugin: "codex",
      scope: "machine",
      taken: "handbook",
    },
  ],
};

const WORKSPACE = "/Users/someone/code/foundry";
const done = () => Promise.resolve();
const pending = () => new Promise<void>(() => undefined);
const refused = () =>
  Promise.reject(
    new Error("Could not save providers: settings are read-only.")
  );

function providers(
  review: Review,
  onContinue: () => Promise<void> = done,
  replay?: Replay
) {
  return (renderer: Parameters<typeof renderReactStory>[0]) =>
    renderReactStory(
      renderer,
      <ReplayKeys replay={replay}>
        <ProviderOnboarding
          onClose={ignore}
          onContinue={onContinue}
          review={review}
          workspace={WORKSPACE}
        />
      </ReplayKeys>
    );
}

export default defineStories({
  component: "ProviderOnboarding",
  description:
    "The intro screens before setup: model providers found on this machine, and opening a workspace that already has a Marbles source.",
  title: "Views/OnboardingIntro",
});

export const Detected = story({
  description: "Providers found on this machine, offered for every workspace.",
  name: "Providers detected",
  render: providers(detected),
});

export const Configured = story({
  description: "Providers are already set up; Enter continues and keeps them.",
  name: "Already configured",
  render: providers(configured),
});

export const NoProviders = story({
  description: "Nothing found on this machine; setup carries on without them.",
  name: "No providers",
  render: providers(none),
});

export const Reserved = story({
  description:
    "One provider is offered; another belongs to a different workspace.",
  name: "Provider reserved elsewhere",
  render: providers(reserved),
});

export const Saving = story({
  description: "Enter was pressed and saving has not finished.",
  name: "Saving",
  render: providers(detected, pending, {
    keys: ["return"],
    shows: "Saving…",
  }),
});

export const SaveFailed = story({
  description:
    "Saving the providers failed; the error shows above the actions.",
  name: "Save failed",
  render: providers(detected, refused, {
    keys: ["return"],
    shows: "Could not save providers: settings are read-only.",
  }),
});

export const Quitting = story({
  description: "q opens the quit dialog.",
  name: "Quit dialog",
  render: providers(detected, done, {
    keys: ["q"],
    shows: "Quit Marbles?",
  }),
});

export const Welcome = story({
  description: "A workspace with an existing Marbles source, ready to load.",
  name: "Open an existing workspace",
  render: (renderer) =>
    renderReactStory(
      renderer,
      <WorkspaceWelcome
        onClose={ignore}
        onContinue={done}
        path={`${WORKSPACE}/.foundry/marbles`}
        workspace={WORKSPACE}
      />
    ),
});
