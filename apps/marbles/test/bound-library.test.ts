import { expect, it } from "vitest";
import { libraryOfLoad, prebuiltOfLoad, WORDS } from "~/authoring/bound";
import { Catalog } from "~/authoring/catalog";
import { loadInto } from "~/authoring/runtime";

// Whole modules, as a load sees them: every export is checked.
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
  // A new word in one of these modules must be bound too.
  expect(new Set(words.map(([, word]) => word))).toEqual(WORDS);
  const bound = libraryOfLoad(library, 1);
  for (const [name, word] of words) {
    if (name in library) {
      expect(bound[name], name).toBeTypeOf("function");
      expect(bound[name], name).not.toBe(word);
    }
  }
  expect(bound.tasks).not.toBe(library.tasks);
  // Classes and values pass through, so instanceof and identity hold.
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
  await loadInto("bound-library-test", into, (load) => {
    const { schedule, step } = libraryOfLoad(library, load) as typeof library;
    const built = step("now").do(() => 1);
    schedule(built).every("1h");
    const pending = step("later");
    later = () => {
      pending.do(() => 2);
    };
    return Promise.resolve();
  });
  // Outside the load, and outside any run: the builder still names its load.
  later?.();
  expect([...into.definitions.keys()]).toEqual(["now", "later"]);
  expect([...into.schedules.keys()]).toEqual(["now"]);
});
