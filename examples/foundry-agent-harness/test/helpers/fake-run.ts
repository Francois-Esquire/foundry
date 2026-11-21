import type { Weapon } from "../../src/model/context";
import type { Run, Thread } from "../../src/model/thread";

export function fakeRun(thread: Thread): {
  readonly goals: string[];
  readonly run: Run;
  readonly weapons: Weapon[];
} {
  const goals: string[] = [];
  const weapons: Weapon[] = [];
  const run: Run = (goal, show, weapon) => {
    goals.push(goal);
    weapons.push(weapon);
    show(thread);
    return Promise.resolve();
  };
  return { goals, run, weapons };
}
