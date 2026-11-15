import { step, workflow } from "~/authoring/builder";
import { observe } from "~/authoring/observe";
import { agent, artifact, sandbox, workspace } from "~/authoring/resources";
import { inLoad } from "~/authoring/runtime";
import { tasksOfLoad } from "~/authoring/tasks";
import { monitor, schedule } from "~/authoring/triggers";

/**
 * The library a load's modules import in place of `@foundry.sh/marbles`
 * and `@foundry.sh/marbles/prebuilt`: the same exports, but each word that
 * declares or routes runs as that load's (`inLoad`), and `tasks` is the
 * load's own. So a workspace's code names its workspace by what it
 * imported, however late it calls and from wherever: a timer, a listener,
 * a promise or a tail call. Classes and values pass through as they are,
 * so `instanceof`, identity and symbols keep working.
 */

function isClass(value: unknown): boolean {
  return (
    typeof value === "function" &&
    Function.prototype.toString.call(value).startsWith("class")
  );
}

/**
 * The authoring words that declare or route. Every function those modules
 * export is one; a test holds the list to them.
 */
export const WORDS: ReadonlySet<unknown> = new Set([
  agent,
  artifact,
  monitor,
  observe,
  sandbox,
  schedule,
  step,
  workflow,
  workspace,
]);

function bind(word: (...args: never[]) => unknown, load: number): unknown {
  return (...args: never[]) => inLoad(load, () => word(...args));
}

/** `@foundry.sh/marbles` as load `load` imports it. */
export function libraryOfLoad(
  library: Readonly<Record<string, unknown>>,
  load: number
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(library).map(([key, value]) => {
      if (key === "tasks") {
        return [key, tasksOfLoad(load)];
      }
      return [
        key,
        WORDS.has(value)
          ? bind(value as (...args: never[]) => unknown, load)
          : value,
      ];
    })
  );
}

/** `@foundry.sh/marbles/prebuilt` as load `load` imports it: every factory runs as the load's. */
export function prebuiltOfLoad(
  prebuilt: Readonly<Record<string, unknown>>,
  load: number
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(prebuilt).map(([key, value]) => [
      key,
      typeof value === "function" && !isClass(value)
        ? bind(value as (...args: never[]) => unknown, load)
        : value,
    ])
  );
}
