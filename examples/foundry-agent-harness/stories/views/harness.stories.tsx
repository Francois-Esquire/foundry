import { defineStories, story } from "textbook-sh";
import { HarnessView } from "@/views/harness";
import { replay } from "../fixtures/run";
import { context, threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 30, padded: false, width: 120 };

export default defineStories({
  component: "HarnessView",
  description:
    "The screen with its state. Type a goal and press Enter to replay sample threads; no agent runs.",
  title: "Views/Harness",
});

export const Succeeds = story({
  description: "A goal is planned, worked through, and kept.",
  name: "Succeeds",
  render: (renderer) =>
    renderFrame(
      renderer,
      <HarnessView
        context={context}
        run={replay([threads.planning, threads.working, threads.done])}
      />,
      size
    ),
});

export const Fails = story({
  description: "A goal is planned and its first turn fails.",
  name: "Fails",
  render: (renderer) =>
    renderFrame(
      renderer,
      <HarnessView
        context={context}
        run={replay([threads.planning, threads.failed])}
      />,
      size
    ),
});
