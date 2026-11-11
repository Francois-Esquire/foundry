/** @vitest-environment happy-dom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSettled } from "~/lib/use-settled";

afterEach(cleanup);

/** Requests that are answered by hand, so the order of the answers is the test's. */
const requests = () => {
  const waiting = new Map<
    string,
    { fail(error: unknown): void; answer(value: string): void }
  >();
  const load = (key: string) =>
    new Promise<string>((answer, fail) => {
      waiting.set(key, { answer, fail });
    });
  return { load, waiting };
};

describe("the newest request's answer", () => {
  it("is nothing until the request is answered, then the answer with its key", async () => {
    const { load, waiting } = requests();
    const { result } = renderHook(() => useSettled("a", load));
    expect(result.current).toBeUndefined();
    await act(async () => {
      waiting.get("a")?.answer("first");
      await Promise.resolve();
    });
    expect(result.current).toEqual({ key: "a", value: "first" });
  });

  it("keeps a failure with its key, so a request that fails stops waiting", async () => {
    const { load, waiting } = requests();
    const failure = new Error("no data");
    const { result } = renderHook(() => useSettled("a", load));
    await act(async () => {
      waiting.get("a")?.fail(failure);
      await Promise.resolve();
    });
    expect(result.current).toEqual({ error: failure, key: "a" });
  });

  it("drops an answer that arrives after a newer request was made", async () => {
    const { load, waiting } = requests();
    const { rerender, result } = renderHook(
      ({ key }) => useSettled(key, load),
      {
        initialProps: { key: "a" },
      }
    );
    rerender({ key: "b" });
    await act(async () => {
      waiting.get("b")?.answer("second");
      await Promise.resolve();
    });
    await act(async () => {
      waiting.get("a")?.answer("first, late");
      await Promise.resolve();
    });
    expect(result.current).toEqual({ key: "b", value: "second" });
  });

  it("shows the answer to the key before until the new key is answered", async () => {
    const { load, waiting } = requests();
    const { rerender, result } = renderHook(
      ({ key }) => useSettled(key, load),
      {
        initialProps: { key: "a" },
      }
    );
    await act(async () => {
      waiting.get("a")?.answer("first");
      await Promise.resolve();
    });
    rerender({ key: "b" });
    expect(result.current).toEqual({ key: "a", value: "first" });
  });

  it("asks once for a key, however often it renders", () => {
    let asked = 0;
    const load = (key: string) => {
      asked += 1;
      return Promise.resolve(key);
    };
    const { rerender } = renderHook(() => useSettled("a", load));
    rerender();
    rerender();
    expect(asked).toBe(1);
  });

  it("drops an answer that arrives after the component has gone", async () => {
    const { load, waiting } = requests();
    const { result, unmount } = renderHook(() => useSettled("a", load));
    unmount();
    await act(async () => {
      waiting.get("a")?.answer("late");
      await Promise.resolve();
    });
    expect(result.current).toBeUndefined();
  });
});
