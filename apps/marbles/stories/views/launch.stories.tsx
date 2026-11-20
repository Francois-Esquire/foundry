import { defineStories, story } from "textbook-sh";
import type { DefinitionSnapshot } from "~/cli/state/dashboard-model";
import { LaunchView } from "~/cli/views/launch";
import { previewScenarios } from "../fixtures/scenarios";
import { ignore } from "../frame";
import { renderReactStory } from "../render-react-story";
import { ReplayKeys, type StoryKey } from "./replay-keys";

function scenarioDefinition(scenario: string, id: string): DefinitionSnapshot {
  const definition = previewScenarios
    .find((item) => item.id === scenario)
    ?.frames[0]?.definitions.find((item) => item.id === id);
  if (!definition) {
    throw new Error(`The ${scenario} scenario has no ${id} definition.`);
  }
  return definition;
}

const prototype = scenarioDefinition("launch-form", "prototype");
const unavailable = scenarioDefinition("launch-error", "unavailable");

const undeclared: DefinitionSnapshot = {
  description: "Summarise the day's merged changes.",
  id: "summary",
  kind: "workflow",
  name: "summarize-day",
};

const unusable: DefinitionSnapshot = {
  description: "Publish the generated notes.",
  id: "publish",
  input: {
    fields: [
      { label: "Channel", name: "channel", options: [], type: "select" },
    ],
  },
  kind: "workflow",
  name: "publish-notes",
};

const SUBMIT: StoryKey = { ctrl: true, name: "return", sequence: "\r" };
const FILL_AND_SUBMIT = ["d", "o", "c", "s", SUBMIT];

const started = () => Promise.resolve("run-105");
const pending = () => new Promise<string>(() => undefined);
const refused = () =>
  Promise.reject(new Error("Executor unavailable. Your inputs are preserved."));

function launch(
  definition: DefinitionSnapshot,
  onLaunch: (name: string) => Promise<string> = started,
  keys: readonly (string | StoryKey)[] = []
) {
  return (renderer: Parameters<typeof renderReactStory>[0]) =>
    renderReactStory(
      renderer,
      <ReplayKeys keys={keys}>
        <LaunchView
          definition={definition}
          onCancel={ignore}
          onClose={ignore}
          onLaunch={onLaunch}
          onStarted={ignore}
        />
      </ReplayKeys>
    );
}

export default defineStories({
  component: "LaunchView",
  description:
    "The launch form for a step or workflow that declares arguments, opened from the catalog.",
  title: "Views/Launch",
});

export const Arguments = story({
  description:
    "Every argument control: text, multiline, number, boolean, and select.",
  name: "Arguments",
  render: launch(prototype),
});

export const Required = story({
  description: "A single required text argument.",
  name: "One required argument",
  render: launch(unavailable),
});

export const MissingRequired = story({
  description: "Ctrl+Enter with the required fields empty marks each one.",
  name: "Missing required values",
  render: launch(prototype, started, [SUBMIT]),
});

export const Launching = story({
  description: "A launch that has not come back yet; the form waits.",
  name: "Launching",
  render: launch(unavailable, pending, FILL_AND_SUBMIT),
});

export const Refused = story({
  description: "The executor refused the launch; the typed value stays.",
  name: "Launch failed",
  render: launch(unavailable, refused, FILL_AND_SUBMIT),
});

export const Undeclared = story({
  description:
    "A definition without argument metadata cannot be launched from here.",
  name: "Arguments not declared",
  render: launch(undeclared),
});

export const Unusable = story({
  description: "A select argument with no choices cannot be filled in.",
  name: "Unusable arguments",
  render: launch(unusable),
});
