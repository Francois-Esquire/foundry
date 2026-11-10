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
  type EngineClient,
  type EngineStatus,
} from "~/packaging/engine/client";
import { validateDerivedFont } from "~/packaging/validation";
import { resolveVariableBuild } from "~/packaging/variable-build";
import type { Outline } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";
import {
  ACCENTED,
  acceptEverything,
  generateSofiaFamily,
} from "../../generation/family/helpers/sofia-family";

const ADDED_CHARACTER = 0xe0_00;
const ADDED_ADVANCE = 1000;
const FONT_SIZE = 100;
const VARIABLE_FAMILY = "Engine Check Variable";
/** The masters sit at 300, 400 and 800. The others fall between them. */
const RENDERED_WEIGHTS = [300, 350, 400, 600, 800];
const CANVAS = { height: 220, width: 520 };

const TRIANGLE: Outline = {
  contours: [
    {
      segments: [
        { kind: "line", to: { x: 500, y: 700 } },
        { kind: "line", to: { x: 900, y: 0 } },
      ],
      start: { x: 100, y: 0 },
    },
  ],
};

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

const fetchFont = async (file: string) => {
  const response = await fetch(`/test/fixtures/fonts/${file}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** How much ink Chrome puts down for a text at one weight, summed over the pixels. */
const inkAt = (family: string, text: string, weight: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS.width;
  canvas.height = CANVAS.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The page has no 2D canvas.");
  }
  context.font = `${weight} ${FONT_SIZE}px "${family}"`;
  context.fillText(text, 10, 150);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let ink = 0;
  for (let alpha = 3; alpha < data.length; alpha += 4) {
    ink += data[alpha] ?? 0;
  }
  return Math.round(ink / 255);
};

/** Sets a text at one weight, as Chrome lays it out and as the font's own advances say. */
const renderedAt = (face: OpenFace, text: string, weight: number) => {
  const sample = document.createElement("span");
  sample.style.font = `${weight} ${FONT_SIZE}px "${VARIABLE_FAMILY}"`;
  sample.style.fontKerning = "none";
  sample.textContent = text;
  document.querySelector("#sample")?.append(sample);
  const shaped = face.shape(text, {
    features: { kern: false },
    location: { wght: weight },
  });
  const advance = shaped.glyphs.reduce((sum, glyph) => sum + glyph.xAdvance, 0);
  return {
    expectedWidth: (advance * FONT_SIZE) / face.description.metrics.unitsPerEm,
    ink: inkAt(VARIABLE_FAMILY, text, weight),
    weight,
    width: sample.getBoundingClientRect().width,
  };
};

/**
 * The family milestone in the browser: generate the same accented letters
 * for three weights of Sofia Sans, rebuild a variable font from them in the
 * worker, and have Chrome draw the new letters between the masters.
 */
const rebuildVariable = async (engine: EngineClient) => {
  const sofia = await fetchFont("SofiaSans-wght.ttf");
  const { generation } = await generateSofiaFamily(sofia);
  const project = acceptEverything(generation);
  const { problems, request } = resolveVariableBuild(
    project,
    generation.instances.map((instance) => instance.face.id),
    { familyName: VARIABLE_FAMILY }
  );
  if (!request) {
    throw new Error(problems.map((problem) => problem.message).join(" "));
  }
  const started = performance.now();
  const built = await engine.buildVariable(request);
  const roundTripMs = Math.round(performance.now() - started);
  const face = harfBuzzReader.open(built.bytes);
  document.fonts.add(
    await loadInBrowser(built.bytes, VARIABLE_FAMILY, {
      weight: `${built.axis.min} ${built.axis.max}`,
    })
  );
  return {
    axis: built.axis,
    bytes: built.bytes.byteLength,
    compatible: generation.compatibility.every((entry) => entry.compatible),
    glyphCount: built.glyphCount,
    notes: built.notes,
    rendered: RENDERED_WEIGHTS.map((weight) =>
      renderedAt(face, ACCENTED, weight)
    ),
    roundTripMs,
    sourceBytesAfterBuild: sofia.byteLength,
    timings: built.timings,
    validation: await engine.validate(built.bytes),
  };
};

/** A blank font from the worker, given one glyph by a normal build, and drawn by Chrome. */
const fillBlankFont = async (engine: EngineClient) => {
  const blank = await engine.blankFont({
    familyName: "Engine Check Blank",
    metrics: { ascender: 800, descender: -200, lineGap: 0, unitsPerEm: 1000 },
    styleName: "Regular",
  });
  await loadInBrowser(blank.bytes, "Engine Check Blank");
  const filled = await engine.build({
    added: [
      {
        advance: ADDED_ADVANCE,
        characters: [ADDED_CHARACTER],
        key: "triangle",
        name: "triangle",
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
    ],
    faceIndex: 0,
    featureCode: [],
    overrides: new Map(),
    source: blank.bytes,
  });
  return {
    blankBytes: blank.bytes.byteLength,
    blankGlyphs: blank.glyphCount,
    filledGlyphs: filled.glyphCount,
    validation: await engine.validate(blank.bytes),
    width: await renderedWidth("Engine Check Filled", filled.bytes),
  };
};

const run = async () => {
  const statuses: EngineStatus[] = [];
  const engine = createEngineClient();
  statuses.push(engine.status());
  engine.subscribe((status) => statuses.push(status));

  const source = await fetchFont("Lato-Regular.ttf");
  const request: BuildRequest = {
    added: [
      {
        advance: ADDED_ADVANCE,
        characters: [ADDED_CHARACTER],
        key: "triangle",
        name: "triangle",
        outline: TRIANGLE,
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
    blank: await fillBlankFont(engine),
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
    variable: await rebuildVariable(engine),
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
