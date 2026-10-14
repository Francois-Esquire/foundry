import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createModuleRecords } from "~/main/modules/library";
import {
  openLocalModuleLibrary,
  openModuleStore,
} from "~/main/modules/local-library";
import { startTestExecution } from "../helpers/execution";
import { recordedSaves, unrecordedSaves } from "../helpers/source-saves";

/** Saves per path; small enough for the default suite, enough for a median. */
const SAMPLES = 20;
/** The spec's recommended added-latency target, used here on the median. */
const TARGET_MS = 50;
/**
 * Forty fenced saves on disk, each with disk synchronization, take 2.5–5 s
 * while the whole repository's tests run in parallel: past vitest's 5 s
 * default. The assertion compares medians, so a slow machine is not a
 * failure; only the time budget is widened.
 */
const BUDGET_MS = 30_000;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

function median(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

it("adds no noticeable latency to a fenced save on disk", {
  timeout: BUDGET_MS,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "works-save-latency-"));
  roots.push(root);
  const execution = await startTestExecution({
    directory: path.join(root, "engine"),
  });
  // One Module store and folder, saved through two libraries: one whose
  // saves record nothing, one whose saves are recorded runs, as in Works.
  const modules = path.join(root, "modules");
  const store = await openModuleStore(modules);
  const records = createModuleRecords(store);
  const direct = await openLocalModuleLibrary(modules, {
    records,
    saves: unrecordedSaves,
  });
  const routed = await openLocalModuleLibrary(modules, {
    records,
    saves: recordedSaves(execution, store),
  });
  const module = await direct.create("Latency");
  const details = await direct.details(module.id);
  if (!details?.binding) {
    throw new Error("Binding missing");
  }
  let { binding } = details;
  const timings = { direct: [] as number[], routed: [] as number[] };
  // Alternate the paths so disk and cache drift affects both alike.
  for (let index = 0; index < SAMPLES * 2; index += 1) {
    const route = index % 2 === 0 ? "direct" : "routed";
    const library = route === "direct" ? direct : routed;
    const started = performance.now();
    binding = await library.saveSource(
      module.id,
      { ...details.source, "README.md": `save ${index}` },
      binding
    );
    timings[route].push(performance.now() - started);
  }
  expect(median(timings.routed) - median(timings.direct)).toBeLessThan(
    TARGET_MS
  );
});
