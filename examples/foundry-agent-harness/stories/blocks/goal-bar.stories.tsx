import { defineStories, story } from "textbook-sh";
import { GoalBar } from "@/components/blocks/goal-bar";
import { clock } from "../fixtures/threads";
import { ignore, renderFrame } from "../frame";

const size = { height: 5, width: 72 };

export default defineStories({
  component: "GoalBar",
  description: "Where a goal is typed. Enter hands it over.",
  title: "Blocks/GoalBar",
});

export const Idle = story({
  description: "Ready for a goal.",
  name: "Idle",
  render: (renderer) =>
    renderFrame(
      renderer,
      <GoalBar
        busy={false}
        draft=""
        frame={clock.frame}
        onDraft={ignore}
        onSubmit={ignore}
        width={70}
      />,
      size
    ),
});

export const Drafted = story({
  description: "A goal typed and not yet handed over.",
  name: "Drafted",
  render: (renderer) =>
    renderFrame(
      renderer,
      <GoalBar
        busy={false}
        draft="List the source files here and say what each one is for."
        frame={clock.frame}
        onDraft={ignore}
        onSubmit={ignore}
        width={70}
      />,
      size
    ),
});

export const Busy = story({
  description: "A goal is running, so Enter does nothing.",
  name: "Busy",
  render: (renderer) =>
    renderFrame(
      renderer,
      <GoalBar
        busy
        draft=""
        frame={clock.frame}
        onDraft={ignore}
        onSubmit={ignore}
        width={70}
      />,
      size
    ),
});
