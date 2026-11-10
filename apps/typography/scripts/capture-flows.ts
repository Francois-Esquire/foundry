/**
 * Drives the real app in Chrome through its user flows and writes captioned
 * screenshots with a page to browse them (index.html in the output directory).
 *
 * Usage, from apps/typography. This makes no model call and needs no key:
 *   bun scripts/capture-flows.ts [--only <flow>[,<flow>]] [--out .cache/flows] [--port 5341]
 *
 * With --live the flows that call a model for real run too. They cost money.
 * The key is read from this process's environment and typed into the app's
 * masked field, as a person would. From the repository root:
 *   bun run env:run -- bun --cwd apps/typography scripts/capture-flows.ts --live
 *
 * A run retakes the flows it ran and keeps every other flow as it was last
 * captured. The three flows that call a model run only with --live, so a free
 * run never removes what they cost. One run makes at most three model calls,
 * one to the image model. The output directory is under .cache by default,
 * which `bun run clean` deletes.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { startApp } from "../test/e2e/support/app";
import acrossWeights from "./capture/across-weights";
import { Capture } from "./capture/context";
import coverage from "./capture/coverage";
import captureExport from "./capture/export";
import { mergeManifest, readManifest, writeGallery } from "./capture/gallery";
import generateByRule from "./capture/generate-by-rule";
import generateLive from "./capture/generate-live";
import generateRecorded from "./capture/generate-recorded";
import library from "./capture/library";
import proof from "./capture/proof";
import { reconstruct, reconstructLive } from "./capture/reconstruct";
import scriptExtension from "./capture/script-extension";
import startAndImport from "./capture/start-and-import";
import studio from "./capture/studio";

interface Flow {
  /** True for a flow that only exists as a call to a model. */
  readonly live?: boolean;
  readonly name: string;
  readonly run: (capture: Capture) => Promise<void>;
}

const FLOWS: readonly Flow[] = [
  { name: "01-start-and-import", run: startAndImport },
  { name: "02-library", run: library },
  { name: "03-coverage", run: coverage },
  { name: "04-studio", run: studio },
  { name: "05-generate-by-rule", run: generateByRule },
  { name: "06-generate-recorded", run: generateRecorded },
  { live: true, name: "07-generate-live-vector", run: generateLive("Vector") },
  { live: true, name: "08-generate-live-image", run: generateLive("Image") },
  { name: "09-script-extension", run: scriptExtension },
  { name: "10-across-weights", run: acrossWeights },
  { name: "11-reconstruct", run: reconstruct },
  { live: true, name: "12-reconstruct-live", run: reconstructLive },
  { name: "13-proof", run: proof },
  { name: "14-export", run: captureExport },
];
const NUMBER_PREFIX = 3;

const { values } = parseArgs({
  options: {
    live: { default: false, type: "boolean" },
    only: { type: "string" },
    out: { default: ".cache/flows", type: "string" },
    port: { default: "5341", type: "string" },
  },
});

const chosen = (): readonly Flow[] => {
  if (!values.only) {
    return FLOWS.filter((flow) => values.live || !flow.live);
  }
  return values.only.split(",").map((wanted) => {
    const flow = FLOWS.find(
      ({ name }) => name === wanted || name.slice(NUMBER_PREFIX) === wanted
    );
    if (!flow) {
      throw new Error(
        `There is no flow named ${wanted}. Choose from ${FLOWS.map(({ name }) => name.slice(NUMBER_PREFIX)).join(", ")}.`
      );
    }
    if (flow.live && !values.live) {
      throw new Error(`${flow.name} calls a model. Add --live to run it.`);
    }
    return flow;
  });
};

const selected = chosen();
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("The port must be a whole number from 1024 to 65535.");
}
const key = process.env.FAL_API_KEY;
if (values.live && !key) {
  throw new Error(
    "--live needs FAL_API_KEY in the environment. Run it through env:run from the repository root."
  );
}
const out = path.resolve(import.meta.dirname, "..", values.out);
await mkdir(out, { recursive: true });
const previous = await readManifest(out);
const at = new Date().toISOString();
const retaken: string[] = [];
const app = await startApp({ port });
app.page.setDefaultTimeout(30_000);
const capture = new Capture(app, out, values.live, key);

const record = () =>
  writeGallery(
    out,
    mergeManifest(previous, {
      at,
      calls: capture.calls,
      order: FLOWS.map((flow) => flow.name),
      problems: capture.problems,
      retaken,
      shots: capture.shots,
    })
  );

try {
  await capture.guard();
  for (const { name, run } of selected) {
    console.log(`Capturing ${name}`);
    await rm(path.join(out, name), { force: true, recursive: true });
    retaken.push(name);
    await capture.start(name);
    try {
      await run(capture);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown failure";
      capture.problem(
        `The capture stopped here. ${key ? message.replaceAll(key, "[key]") : message}`
      );
      await capture.shot(
        "capture-stopped",
        "The capture stopped at this screen. The flow's problem says which step failed."
      );
    }
    await record();
  }
} finally {
  await record();
  await capture.assertNoKey();
  await app.close();
}
console.log(
  `${capture.shots.length} shots in ${retaken.length} flows, ${capture.calls.length} model calls, ${capture.problems.length} problems. Open ${path.join(out, "index.html")}`
);
if (capture.problems.length > 0) {
  process.exitCode = 1;
}
