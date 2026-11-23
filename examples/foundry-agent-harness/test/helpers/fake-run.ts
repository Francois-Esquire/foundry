import type { Loadout } from "../../src/model/context";
import type { Run, Thread } from "../../src/model/thread";

export function fakeRun(thread: Thread): {
  readonly goals: string[];
  readonly run: Run;
  readonly loadouts: Loadout[];
} {
  const goals: string[] = [];
  const loadouts: Loadout[] = [];
  const run: Run = (goal, show, loadout) => {
    goals.push(goal);
    loadouts.push(loadout);
    show(thread);
    return Promise.resolve();
  };
  return { goals, loadouts, run };
}
