import { expect, it, vi } from "vitest";
import { ExecutionAudit } from "~/main/execution/audit";
import { latest } from "~/main/platform/latest";
import { startTestExecution } from "../helpers/execution";

it("keeps changes received between an audit snapshot and subscription setup completing", async () => {
  const execution = await startTestExecution();
  const subscribe = execution.runs.subscribe.bind(execution.runs);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const audit = new ExecutionAudit({
    runs: {
      gaps: () => execution.runs.gaps(),
      async subscribe(listener) {
        const subscription = await subscribe(listener);
        entered.resolve();
        await release.promise;
        return subscription;
      },
    },
  });
  const watching = audit.watch();
  await entered.promise;
  await execution.dispatch("subscription-race", {}, () => "done");
  release.resolve();
  const events = await watching;
  try {
    expect(await events.next()).toMatchObject({
      value: { runs: [], type: "snapshot" },
    });
    expect(await events.next()).toMatchObject({
      value: { run: { name: "subscription-race" }, type: "run" },
    });
  } finally {
    await events.return();
  }
});

it("disposes a subscription that completes after its follower was cancelled", async () => {
  const controller = new AbortController();
  const release = Promise.withResolvers<() => void>();
  const unsubscribe = vi.fn();
  const read = vi.fn(() => "value");
  const events = latest({
    read,
    signal: controller.signal,
    subscribe: () => release.promise,
  });
  const next = events.next();
  controller.abort();
  release.resolve(unsubscribe);
  expect(await next).toEqual({ done: true, value: undefined });
  expect(read).not.toHaveBeenCalled();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
