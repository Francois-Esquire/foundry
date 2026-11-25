import { expect, it } from "vitest";
import { libraryOfLoad, prebuiltOfLoad, WORDS } from "~/authoring/bound";
import { Catalog } from "~/authoring/catalog";
import { loadInto } from "~/authoring/runtime";
import { SOURCE } from "~/lib/events/source";

const library = await import("~/authoring");
const prebuilt = await import("~/authoring/prebuilt");
const modules = await Promise.all([
  import("~/authoring/builder"),
  import("~/authoring/observe"),
  import("~/authoring/resources"),
  import("~/authoring/triggers"),
]);

const isClass = (value: unknown) =>
  typeof value === "function" &&
  Function.prototype.toString.call(value).startsWith("class");

it("binds every authoring word and prebuilt factory to the load that imports it", () => {
  const words = modules.flatMap((module) =>
    Object.entries(module).filter(
      ([, value]) => typeof value === "function" && !isClass(value)
    )
  );
  expect(new Set(words.map(([, word]) => word))).toEqual(WORDS);
  const bound = libraryOfLoad(library, 1);
  for (const [name, word] of words) {
    if (name in library) {
      expect(bound[name], name).toBeTypeOf("function");
      expect(bound[name], name).not.toBe(word);
    }
  }
  expect(bound.tasks).not.toBe(library.tasks);
  expect(bound.runs).not.toBe(library.runs);
  expect(bound.Tasks).toBe(library.Tasks);
  expect(bound.TaskError).toBe(library.TaskError);
  const factories = prebuiltOfLoad(prebuilt, 1);
  for (const [name, factory] of Object.entries(prebuilt)) {
    if (typeof factory === "function") {
      expect(factories[name], name).not.toBe(factory);
    }
  }
});

it("declares what a load's words make into that load's catalog, however late `.do` is called", async () => {
  const into = new Catalog();
  let later: (() => void) | undefined;
  await loadInto(
    "bound-library-test",
    into,
    (load) => {
      const { schedule, step } = libraryOfLoad(library, load) as typeof library;
      const built = step("now").do(() => 1);
      schedule(built).every("1h");
      const pending = step("later");
      later = () => {
        pending.do(() => 2);
      };
      return Promise.resolve();
    },
    { dry: false }
  );
  later?.();
  expect([...into.definitions.keys()]).toEqual(["now", "later"]);
  expect([...into.schedules.keys()]).toEqual(["now"]);
});

it("binds `step.launch` and `workflow.launch` to the load too, and keeps `workflow` observable", () => {
  const bound = libraryOfLoad(library, 1) as typeof library;
  for (const word of [bound.step, bound.workflow]) {
    expect(word.launch).toBeTypeOf("function");
  }
  expect(bound.step.launch).not.toBe(library.step.launch);
  expect(bound.workflow.launch).not.toBe(library.workflow.launch);
  expect(Reflect.get(bound.workflow, SOURCE)).toBe(
    Reflect.get(library.workflow, SOURCE)
  );
});
