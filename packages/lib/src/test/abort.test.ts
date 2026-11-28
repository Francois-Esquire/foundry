import { describe, expect, it, vi } from "vitest";
import { withAbort } from "../abort";

describe("withAbort", () => {
  it("passes the work result and rejection through", async () => {
    const { signal } = new AbortController();
    const failure = new Error("failed");

    await expect(withAbort(Promise.resolve("done"), signal)).resolves.toBe(
      "done"
    );
    await expect(withAbort(Promise.reject(failure), signal)).rejects.toBe(
      failure
    );
  });

  it("rejects with the signal reason when aborted mid-flight", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    const work = new Promise<never>(() => undefined);
    const racing = withAbort(work, controller.signal);

    controller.abort(reason);

    await expect(racing).rejects.toBe(reason);
  });

  it("rejects an already aborted signal and absorbs a later work rejection", async () => {
    const reason = new Error("already stopped");
    const work = Promise.reject(new Error("late"));

    await expect(withAbort(work, AbortSignal.abort(reason))).rejects.toBe(
      reason
    );
  });

  it("rejects with the supplied reason", async () => {
    const controller = new AbortController();
    const custom = new Error("custom");
    const racing = withAbort(
      new Promise<never>(() => undefined),
      controller.signal,
      () => custom
    );

    controller.abort();

    await expect(racing).rejects.toBe(custom);
  });

  it("removes its abort listener once the work settles", async () => {
    const { signal } = new AbortController();
    const removed = vi.spyOn(signal, "removeEventListener");

    await withAbort(Promise.resolve(), signal);

    await vi.waitFor(() =>
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function))
    );
  });

  it("rejects cleanly if the custom reason callback throws", async () => {
    const controller = new AbortController();
    const boom = new Error("reason-failed");
    const racing = withAbort(
      new Promise<never>(() => undefined),
      controller.signal,
      () => {
        throw boom;
      }
    );

    controller.abort();

    await expect(racing).rejects.toBe(boom);
  });
});
