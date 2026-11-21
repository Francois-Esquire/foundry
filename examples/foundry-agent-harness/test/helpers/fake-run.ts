import type { Run, Thread } from "../../src/model/thread";

export function fakeRun(thread: Thread): {
  readonly goals: string[];
  readonly run: Run;
} {
  const goals: string[] = [];
  const run: Run = (goal, show) => {
    goals.push(goal);
    show(thread);
    return Promise.resolve();
  };
  return { goals, run };
}
