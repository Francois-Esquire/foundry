import type { ModulePrincipal } from "@foundry/modules/gateway/types";
import { expect, it } from "vitest";
import {
  EditorBindingDenied,
  EditorBindings,
  UNCLAIMED_BINDING_TTL_MS,
} from "~/main/artifacts/bindings";

const BINDING = {
  artifactId: "artifact",
  contentId: "content",
  entry: "notes.md",
  installationId: "installation",
  mode: "write",
  moduleId: "module",
  release: "release",
  view: "editor",
} as const;

const RUNTIME = {
  contentId: "release",
  generation: 1,
  installationId: "installation",
  moduleId: "module",
  runtimeInstanceId: "runtime-1",
} as unknown as ModulePrincipal;

it("expires a binding no runtime claimed in time, and keeps a claimed one", () => {
  let now = 0;
  const bindings = new EditorBindings({ now: () => now });
  const unclaimed = bindings.open(BINDING);
  const claimed = bindings.open(BINDING);
  bindings.resolve(RUNTIME, claimed.id);

  now = UNCLAIMED_BINDING_TTL_MS - 1;
  expect(bindings.current(unclaimed)).toBe(true);

  now = UNCLAIMED_BINDING_TTL_MS;
  expect(() => bindings.resolve(RUNTIME, unclaimed.id)).toThrow(
    EditorBindingDenied
  );
  expect(unclaimed.signal.aborted).toBe(true);
  expect(bindings.current(unclaimed)).toBe(false);
  // The claimed one lasts as long as its runtime.
  now = UNCLAIMED_BINDING_TTL_MS * 10;
  expect(bindings.resolve(RUNTIME, claimed.id).id).toBe(claimed.id);
});

it("pins a binding a Program created to it at once, so it never expires unclaimed", () => {
  let now = 0;
  const bindings = new EditorBindings({ now: () => now, unclaimedTtlMs: 10 });
  const owned = bindings.open(BINDING, RUNTIME);
  now = 1000;
  bindings.open(BINDING);
  expect(bindings.resolve(RUNTIME, owned.id).runtime).toEqual({
    generation: 1,
    runtimeInstanceId: "runtime-1",
  });
});
