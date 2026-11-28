import type { Run, Thread } from "@/model/thread";

const STEP_MS = 1500;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asked(thread: Thread, goal: string, round: number): Thread {
  const now = Date.now();
  return {
    ...thread,
    encounters: thread.encounters.map((encounter) => ({
      ...encounter,
      goal,
      id: `${encounter.id}-${round}`,
      steps: encounter.steps.map((step) => ({
        ...step,
        tools: step.tools.map((tool) => ({ ...tool, startedAt: now })),
      })),
    })),
  };
}

export function replay(steps: readonly Thread[]): Run {
  let rounds = 0;
  return async (goal, show) => {
    rounds += 1;
    const round = rounds;
    for (const step of steps) {
      show(asked(step, goal, round));
      await wait(STEP_MS);
    }
  };
}
