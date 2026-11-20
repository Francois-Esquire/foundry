import { defineStories, story } from "textbook-sh";
import { OnboardingView } from "~/cli/views/onboarding";
import { ignore } from "../frame";
import { renderReactStory } from "../render-react-story";
import { ReplayKeys, type StoryKey } from "./replay-keys";

const PATH = "/Users/someone/code/foundry/.foundry/marbles";
const SUBMIT: StoryKey = { ctrl: true, name: "return", sequence: "\r" };
const TO_REVIEW = ["return", SUBMIT];

const created = () => Promise.resolve();
const pending = () => new Promise<void>(() => undefined);
const refused = () =>
  Promise.reject(new Error("A config already exists. It was not overwritten."));

function onboarding(
  keys: readonly (string | StoryKey)[] = [],
  onCreate: () => Promise<void> = created
) {
  return (renderer: Parameters<typeof renderReactStory>[0]) =>
    renderReactStory(
      renderer,
      <ReplayKeys keys={keys}>
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
    "First-run setup: choose a starter, configure its step, then review and create the module.",
  title: "Views/Onboarding",
});

export const Starter = story({
  description: "The first stage: pick a starter; Enter configures it.",
  name: "Choose a starter",
  render: onboarding(),
});

export const OtherStarter = story({
  description: "The Design starter, chosen with the up arrow.",
  name: "Another starter chosen",
  render: onboarding(["up"]),
});

export const Settings = story({
  description: "The second stage: name the step and add instructions.",
  name: "Configure the step",
  render: onboarding(["return"]),
});

export const Review = story({
  description: "The last stage: the module that will be written, and where.",
  name: "Review the module",
  render: onboarding(TO_REVIEW),
});

export const Creating = story({
  description: "Creation has started and not finished yet.",
  name: "Creating",
  render: onboarding([...TO_REVIEW, "return"], pending),
});

export const Refused = story({
  description: "Creation failed; the error shows under the review.",
  name: "Create failed",
  render: onboarding([...TO_REVIEW, "return"], refused),
});

export const Quitting = story({
  description: "q on the first stage opens the quit dialog.",
  name: "Quit dialog",
  render: onboarding(["q"]),
});
