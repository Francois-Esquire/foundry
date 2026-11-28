import { defineStories, story } from "textbook-sh";
import { OnboardingView } from "~/tui/views/onboarding";
import { ignore } from "../frame";
import { renderReactStory } from "../render-react-story";
import { type Replay, ReplayKeys, type StoryKey } from "./replay-keys";

const PATH = "/Users/someone/code/foundry/.foundry/marbles";
const SUBMIT: StoryKey = { ctrl: true, name: "return", sequence: "\r" };
const TO_REVIEW = [SUBMIT];

const created = () => Promise.resolve();
const pending = () => new Promise<void>(() => undefined);
const refused = () =>
  Promise.reject(new Error("A config already exists. It was not overwritten."));

function onboarding(replay?: Replay, onCreate: () => Promise<void> = created) {
  return (renderer: Parameters<typeof renderReactStory>[0]) =>
    renderReactStory(
      renderer,
      <ReplayKeys replay={replay}>
        <OnboardingView
          onClose={ignore}
          onCreate={onCreate}
          onSkip={ignore}
          path={PATH}
        />
      </ReplayKeys>
    );
}

export default defineStories({
  component: "OnboardingView",
  description:
    "First-run setup: configure the starter step, then review and create the module.",
  title: "Views/Onboarding",
});

export const Settings = story({
  description: "The first stage: name the step and add instructions.",
  name: "Configure the step",
  render: onboarding(),
});

export const Review = story({
  description: "The last stage: the module that will be written, and where.",
  name: "Review the module",
  render: onboarding({ keys: TO_REVIEW, shows: "Review and create module" }),
});

export const Creating = story({
  description: "Creation has started and not finished yet.",
  name: "Creating",
  render: onboarding(
    { keys: [...TO_REVIEW, "return"], shows: "Creating module…" },
    pending
  ),
});

export const Refused = story({
  description: "Creation failed; the error shows under the review.",
  name: "Create failed",
  render: onboarding(
    {
      keys: [...TO_REVIEW, "return"],
      shows: "A config already exists. It was not overwritten.",
    },
    refused
  ),
});

export const Quitting = story({
  description: "q on the review stage opens the quit dialog.",
  name: "Quit dialog",
  render: onboarding({ keys: [...TO_REVIEW, "q"], shows: "Quit Marbles?" }),
});
