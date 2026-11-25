import { step, workflow } from "~/authoring/builder";
import { models } from "~/authoring/models";
import { observe } from "~/authoring/observe";
import { agent, artifact, sandbox, workspace } from "~/authoring/resources";
import { runsOfLoad } from "~/authoring/runs";
import { inLoad } from "~/authoring/runtime";
import { tasksOfLoad } from "~/authoring/tasks";
import { monitor, schedule } from "~/authoring/triggers";
import { observable, SOURCE } from "~/lib/events/source";

function isClass(value: unknown): boolean {
  return (
    typeof value === "function" &&
    Function.prototype.toString.call(value).startsWith("class")
  );
}

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
  const bound = (...args: never[]) => inLoad(load, () => word(...args));
  const launch: unknown = Reflect.get(word, "launch");
  if (typeof launch === "function") {
    Object.defineProperty(bound, "launch", {
      value: (...args: unknown[]) =>
        inLoad(load, () => Reflect.apply(launch, word, args)),
    });
  }
  const source: unknown = Reflect.get(word, SOURCE);
  return typeof source === "symbol" ? observable(bound, source) : bound;
}

export function libraryOfLoad(
  library: Readonly<Record<string, unknown>>,
  load: number
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(library).map(([key, value]) => {
      if (key === "tasks") {
        return [key, tasksOfLoad(load)];
      }
      if (key === "runs") {
        return [key, runsOfLoad(load)];
      }
      if (value === models) {
        return [key, { available: bind(models.available, load) }];
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

export function providersOfLoad(
  providers: Readonly<Record<string, unknown>>,
  load: number
): Record<string, unknown> {
  const { defineProvider } = providers;
  return typeof defineProvider === "function"
    ? {
        ...providers,
        defineProvider: bind(
          defineProvider as (...args: never[]) => unknown,
          load
        ),
      }
    : { ...providers };
}
