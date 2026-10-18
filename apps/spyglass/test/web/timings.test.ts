import { afterEach, expect, it, vi } from "vitest";

/** A fresh copy of the module, so the once-per-page marks and the stage counts start empty. */
const timings = async () => {
  vi.resetModules();
  return await import("../../src/web/timings");
};

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

const measures = () =>
  performance
    .getEntriesByType("measure")
    .filter((entry) => entry.name.startsWith("spyglass:"))
    .map((entry) => entry.name);

it("records each point of the load once per page, in order", async () => {
  const { loadMarks, markLoad } = await timings();
  for (const mark of [...loadMarks, ...loadMarks]) {
    markLoad(mark);
  }
  expect(
    performance.getEntriesByType("mark").map((entry) => entry.name)
  ).toEqual([...loadMarks]);
});

it("lets work wait for the first frame, or for the map's failure to open", async () => {
  const framed = await timings();
  let done = false;
  const waiting = framed.afterFirstFrame().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  framed.markLoad("spyglass:first-frame");
  await waiting;
  expect(done).toBe(true);
  // Once released, it no longer waits.
  await framed.afterFirstFrame();
  const failed = await timings();
  const released = failed.afterFirstFrame();
  failed.releaseFirstFrame();
  await expect(released).resolves.toBeUndefined();
});

it("times a stage only in a developer session", async () => {
  const { timeStage } = await timings();
  expect(timeStage(false, "ink", () => 3)).toBe(3);
  expect(measures()).toEqual([]);
  expect(timeStage(true, "ink", () => 4)).toBe(4);
  timeStage(true, "render-submit", () => undefined);
  expect(measures()).toEqual(["spyglass:paint:ink", "spyglass:render-submit"]);
});

it("records a stage that throws, and lets the error through", async () => {
  const { timeStage } = await timings();
  expect(() =>
    timeStage(true, "layer:labels", () => {
      throw new Error("Labels failed.");
    })
  ).toThrow("Labels failed.");
  expect(measures()).toEqual(["spyglass:paint:layer:labels"]);
});

it("keeps at most the cap of each stage's measures, starting again at the cap", async () => {
  const { stageMeasureCap, timeStage } = await timings();
  for (let i = 0; i < stageMeasureCap; i += 1) {
    timeStage(true, "ink", () => undefined);
  }
  timeStage(true, "layer:relief", () => undefined);
  expect(measures()).toHaveLength(stageMeasureCap + 1);
  timeStage(true, "ink", () => undefined);
  expect(measures()).toEqual([
    "spyglass:paint:layer:relief",
    "spyglass:paint:ink",
  ]);
});
