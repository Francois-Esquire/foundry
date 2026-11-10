/**
 * Runs in Chrome, driven by browser-engine.test.ts. Builds derived fonts with
 * the worker engine, loads them through the browser's own font pipeline, and
 * writes what happened into the page for the test to read.
 */
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { loadInBrowser } from "~/packaging/browser-check";
import type { BuildRequest } from "~/packaging/building";
import {
  createEngineClient,
  type EngineStatus,
} from "~/packaging/engine/client";
import { validateDerivedFont } from "~/packaging/validation";

const ADDED_CHARACTER = 0xe0_00;
const ADDED_ADVANCE = 1000;
const FONT_SIZE = 100;

const errorOf = (error: unknown) =>
  error instanceof Error
    ? { message: error.message, name: error.name }
    : { message: String(error), name: "unknown" };

/** Loads built bytes as a web font and measures three of the added glyph. */
const renderedWidth = async (family: string, bytes: Uint8Array) => {
  document.fonts.add(await loadInBrowser(bytes, family));
  const sample = document.createElement("span");
  sample.style.font = `${FONT_SIZE}px "${family}"`;
  sample.textContent = String.fromCodePoint(ADDED_CHARACTER).repeat(3);
  document.querySelector("#sample")?.append(sample);
  return sample.getBoundingClientRect().width;
};

const run = async () => {
  const statuses: EngineStatus[] = [];
  const engine = createEngineClient();
  statuses.push(engine.status());
  engine.subscribe((status) => statuses.push(status));

  const response = await fetch("/test/fixtures/fonts/Lato-Regular.ttf");
  const source = new Uint8Array(await response.arrayBuffer());
  const request: BuildRequest = {
    added: [
      {
        advance: ADDED_ADVANCE,
        characters: [ADDED_CHARACTER],
        key: "triangle",
        name: "triangle",
        outline: {
          contours: [
            {
              segments: [
                { kind: "line", to: { x: 500, y: 700 } },
                { kind: "line", to: { x: 900, y: 0 } },
              ],
              start: { x: 100, y: 0 },
            },
          ],
        },
        provenance: { origin: "manual" },
      },
    ],
    faceIndex: 0,
    familyName: "Engine Check",
    featureCode: [],
    overrides: new Map(),
    source,
    subset: { characters: [0x66, 0x69, ADDED_CHARACTER] },
  };

  const startedAt = performance.now();
  let readyAt = 0;
  engine.subscribe((status) => {
    if (status === "ready") {
      readyAt = performance.now();
    }
  });
  // Three calls made before the engine is up: they must queue and all answer.
  const [ttf, woff2, layout] = await Promise.all([
    engine.build(request),
    engine.build({ ...request, flavor: "woff2" }),
    engine.describeLayout(source),
  ]);
  const firstBuildsAt = performance.now();
  const validation = await engine.validate(ttf.bytes);
  const warmStart = performance.now();
  await engine.build(request);
  const warmBuildMs = performance.now() - warmStart;
  const report = (font: Uint8Array) =>
    validateDerivedFont({
      browserCheck: loadInBrowser,
      builder: engine,
      derived: font,
      reader: harfBuzzReader,
      request,
      samples: [{ text: "fi" }],
    });
  const damaged = ttf.bytes.slice(0, ttf.bytes.byteLength - 200);
  const failure = await engine
    .build({ ...request, source: new Uint8Array([1, 2, 3, 4]) })
    .then(() => null, errorOf);

  return {
    damagedReport: await report(damaged),
    failure,
    layoutGlyphs: layout.glyphNames.length,
    sourceBytesAfterBuild: source.byteLength,
    statuses,
    timings: {
      coldStartMs: Math.round(readyAt - startedAt),
      firstThreeCallsMs: Math.round(firstBuildsAt - startedAt),
      warmBuildMs: Math.round(warmBuildMs),
    },
    ttf: {
      bytes: ttf.bytes.byteLength,
      characters: ttf.characterCount,
      report: await report(ttf.bytes),
      signature: [...ttf.bytes.slice(0, 4)],
      width: await renderedWidth("Engine Check TTF", ttf.bytes),
    },
    validation,
    woff2: {
      bytes: woff2.bytes.byteLength,
      report: await report(woff2.bytes),
      signature: new TextDecoder().decode(woff2.bytes.slice(0, 4)),
      width: await renderedWidth("Engine Check WOFF2", woff2.bytes),
    },
  };
};

/** What the page writes into the DOM, as JSON, for the test to read. */
export type PageResult = Awaited<ReturnType<typeof run>>;

const finish = (state: "done" | "failed", result: unknown) => {
  const output = document.querySelector("#result");
  if (output) {
    output.textContent = JSON.stringify(result);
  }
  document.body.dataset.state = state;
};

run().then(
  (result) => finish("done", result),
  (error: unknown) => finish("failed", errorOf(error))
);
