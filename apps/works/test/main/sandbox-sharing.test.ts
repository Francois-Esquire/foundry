import { expect, it, vi } from "vitest";
import { ModuleBuilds } from "~/main/modules/builds/controller";
import { createBuildRuntime } from "~/main/modules/builds/runtime";
import type {
  ModuleSandboxes,
  ModuleSandboxLoan,
} from "~/main/modules/sandboxes/coordinator";
import { authoringFixture } from "../helpers/authoring";
import { scriptedModels } from "../helpers/authoring-model";
import { startTestExecution } from "../helpers/execution";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Counts the Module sandbox loans out at once, and which containers they lent. */
function trackLoans(sandboxes: ModuleSandboxes) {
  const state = { active: 0, containers: new Set<unknown>(), peak: 0 };
  const borrow = sandboxes.borrow.bind(sandboxes);
  sandboxes.borrow = async (moduleId, options) => {
    const loan = await borrow(moduleId, options);
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    state.containers.add(loan.container);
    let released = false;
    return {
      container: loan.container,
      moduleId: loan.moduleId,
      release() {
        if (!released) {
          released = true;
          state.active -= 1;
        }
        loan.release();
      },
      signal: loan.signal,
    } satisfies ModuleSandboxLoan;
  };
  return state;
}

it("lends a Module's one sandbox to a chat turn and a build at once, and keeps it on while idle", async () => {
  // The chat turn's model call holds until the turn is cancelled.
  const { models } = scriptedModels([{ hold: true }]);
  const execution = await startTestExecution({ models });
  const { binding, details, library, module, runtime, sandboxes, service } =
    await authoringFixture({ execution });
  const loans = trackLoans(sandboxes);

  const sent = await service.send(module.id, {
    binding,
    prompt: "Keep working",
    source: details.source,
  });
  await expect.poll(() => loans.active).toBe(1);

  // A build of the same Module is not queued behind the chat turn: it
  // borrows the same live sandbox while the turn still holds it.
  const builds = new ModuleBuilds({
    execution,
    library,
    runtime: createBuildRuntime(sandboxes),
  });
  const events = await Array.fromAsync(
    builds.watch(module.id, "0.1.0", binding)
  );
  expect(events.at(-1)).toMatchObject({ phase: "complete" });
  expect(loans.peak).toBe(2);
  expect(loans.containers.size).toBe(1);
  expect(runtime.instances).toHaveLength(1);
  const { turns } = await service.conversation(module.id);
  expect(turns.find((turn) => turn.id === sent.id)?.status).toBe("running");

  await service.cancel(module.id, sent.id);
  await expect.poll(() => loans.active).toBe(0);

  // Idle, it stays on: no timeout stops it while the Module is on.
  vi.useFakeTimers();
  try {
    vi.advanceTimersByTime(DAY_MS);
  } finally {
    vi.useRealTimers();
  }
  expect(sandboxes.live()).toEqual([module.id]);
  expect(runtime.instances[0]?.stopped).toBe(false);

  // Only turning the Module off (or quitting) stops it.
  await sandboxes.stop(module.id);
  expect(sandboxes.live()).toEqual([]);
  expect(runtime.instances[0]?.stopped).toBe(true);
}, 30_000);
