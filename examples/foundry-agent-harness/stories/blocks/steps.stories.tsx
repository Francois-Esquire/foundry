import { defineStories, story } from "textbook-sh";
import { HintBar } from "@/components/blocks/hint-bar";
import { Steps } from "@/components/blocks/steps";
import { type Thread, todosOf } from "@/model/thread";
import { clock, threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

export default defineStories({
  component: "Steps",
  description:
    "The to-do list as checkpoints on one line, and the key hints under the screen.",
  title: "Blocks/Steps",
});

const many: Thread = {
  ...threads.working,
  encounters: threads.working.encounters.map((encounter) => ({
    ...encounter,
    todos: Array.from({ length: 8 }, (_, index) => ({
      added: index > 5,
      id: `todo-${index + 1}`,
      status:
        (["success", "success", "success", "running"] as const)[index] ??
        "pending",
      title: `Step number ${index + 1} of the plan`,
    })),
  })),
};

function steps(name: string, description: string, thread: Thread, width = 80) {
  return story({
    description,
    name,
    render: (renderer) =>
      renderFrame(
        renderer,
        <Steps
          frame={clock.frame}
          planning={thread.phase === "planning"}
          todos={todosOf(thread)}
          width={width}
        />,
        { height: 3, width: width + 2 }
      ),
  });
}

export const Empty = steps("Empty", "Before any goal.", threads.idle);

export const Planning = steps(
  "Planning",
  "The planner is working.",
  threads.planning
);

export const Working = steps(
  "Working",
  "One done, one running, one waiting and one the worker added.",
  threads.working
);

export const Failed = steps("Failed", "Every step abandoned.", threads.failed);

export const Crowded = steps(
  "Crowded",
  "Eight steps: the running one keeps its title.",
  many
);

export const Squeezed = steps(
  "Squeezed",
  "Eight steps in 30 columns: a window around the running one.",
  many,
  30
);

export const Hints = story({
  description: "The keys, and the notes once a goal has kept some.",
  name: "Hint bar",
  render: (renderer) =>
    renderFrame(
      renderer,
      <HintBar
        keys={[
          ["↵", "Run"],
          ["Tab", "Next"],
          ["↑/↓", "Gun"],
        ]}
        notes={threads.done.notes}
      />,
      { height: 3, width: 82 }
    ),
});
