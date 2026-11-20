import { defineStories, story } from "textbook-sh";
import { HarnessView } from "@/views/harness";
import { context, threads } from "../fixtures/threads";
import { ignore, renderFrame } from "../frame";

const size = { height: 30, padded: false, width: 120 };

export default defineStories({
  component: "HarnessView",
  description: "The whole screen, drawn from a thread and its context.",
  title: "Views/Harness",
});

export const Idle = story({
  description: "A new thread waiting for a goal.",
  name: "Idle",
  render: (renderer) =>
    renderFrame(
      renderer,
      <HarnessView context={context} onGoal={ignore} thread={threads.idle} />,
      size
    ),
});

export const Planning = story({
  description: "The goal is being planned.",
  name: "Planning",
  render: (renderer) =>
    renderFrame(
      renderer,
      <HarnessView
        context={context}
        onGoal={ignore}
        thread={threads.planning}
      />,
      size
    ),
});

export const Working = story({
  description: "To-dos in progress with a tool call running.",
  name: "Working",
  render: (renderer) =>
    renderFrame(
      renderer,
      <HarnessView
        context={context}
        onGoal={ignore}
        thread={threads.working}
      />,
      size
    ),
});

export const Done = story({
  description: "A finished goal.",
  name: "Done",
  render: (renderer) =>
    renderFrame(
      renderer,
      <HarnessView context={context} onGoal={ignore} thread={threads.done} />,
      size
    ),
});

export const Failed = story({
  description: "A turn failed and the rest were cancelled.",
  name: "Failed",
  render: (renderer) =>
    renderFrame(
      renderer,
      <HarnessView context={context} onGoal={ignore} thread={threads.failed} />,
      size
    ),
});

export const Narrow = story({
  description: "Under 72 columns the panel is dropped.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <HarnessView context={context} onGoal={ignore} thread={threads.done} />,
      { height: 24, padded: false, width: 64 }
    ),
});
