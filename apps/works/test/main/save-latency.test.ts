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

const SAMPLES = 20;
const TARGET_MS = 50;
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
