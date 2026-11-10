import { beforeAll, describe, expect, it } from "vitest";
import {
  RUN_STAGES,
  runGeneration,
  type StageProgress,
} from "~/generation/pipeline/run";
import { MissingDecoderError } from "~/generation/pipeline/stages";
import { planCharacters } from "~/generation/plan/plan";
import type { EncodedFile } from "~/generation/raster/image-codec";
import { falImageClient } from "~/generation/strategies/fal/fal-image-client";
import { falVectorClient } from "~/generation/strategies/fal/fal-vector-client";
import { imageModelStrategy } from "~/generation/strategies/image-model";
import { ModelRequestError } from "~/generation/strategies/model-client";
import {
  loadRecordedRuns,
  RecordedRunError,
  recordedTargets,
} from "~/generation/strategies/recorded/manifest";
import { recordedRunStrategy } from "~/generation/strategies/recorded/recorded-run";
import { StrategyUnavailableError } from "~/generation/strategies/strategy";
import { vectorModelStrategy } from "~/generation/strategies/vector-model";
import {
  analyseStyle,
  type StyleReference,
} from "~/generation/style/reference";
import type { GlyphShape } from "~/typeface/reading";
import { nodeImageCodec } from "../../scripts/generation/node-image-codec";
import { withoutCharacters } from "./helpers/faces";
import { fixtureFace, glyphOf } from "./helpers/glyphs";
import { syntheticManifest, syntheticSheetPng } from "./helpers/recorded";

const lato = fixtureFace("lato");
const PNG: EncodedFile = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  mediaType: "image/png",
};
const CALL = {
  prompt: "Draw a sheet.",
  referenceImages: [PNG],
  size: { height: 1024, width: 1536 },
};

interface Sent {
  readonly body?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly method: string;
  readonly url: string;
}

/** A stand-in for `fetch` that records what was sent and answers from a script. */
const fakeFetch = (answers: readonly Response[]) => {
  const sent: Sent[] = [];
  let next = 0;
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
      headers: init?.headers as Record<string, string> | undefined,
      method: init?.method ?? "GET",
      url: String(input),
    });
    const answer =
      answers[next] ?? new Response("no more answers", { status: 500 });
    next += 1;
    return Promise.resolve(answer);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
};

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

describe("the fal image client", () => {
  it("posts the prompt and reference as fal expects, then fetches the picture", async () => {
    const { fetch, sent } = fakeFetch([
      json({
        images: [
          { content_type: "image/png", url: "https://files.example/sheet.png" },
        ],
      }),
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    ]);
    let now = 1000;
    const client = falImageClient({
      clock: () => {
        now += 250;
        return now;
      },
      fetch,
      key: "test-key",
      quality: "low",
    });
    expect(client.availability()).toEqual({ available: true });
    const result = await client.generate(CALL);
    expect(sent[0]).toMatchObject({
      body: {
        image_size: { height: 1024, width: 1536 },
        image_urls: ["data:image/png;base64,iVBORw=="],
        output_format: "png",
        prompt: "Draw a sheet.",
        quality: "low",
      },
      headers: {
        Authorization: "Key test-key",
        "Content-Type": "application/json",
      },
      method: "POST",
      url: "https://fal.run/openai/gpt-image-2.6/flare/edit",
    });
    expect(sent[1]).toMatchObject({
      method: "GET",
      url: "https://files.example/sheet.png",
    });
    expect(result.image).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    });
    expect(result.model).toBe("openai/gpt-image-2.6/flare/edit");
    expect(result.latencyMs).toBe(250);
    // fal does not state what a call cost, so none is reported.
    expect(result.costUsd).toBeUndefined();
  });

  it("reads a picture returned as a data URI without a second request", async () => {
    const { fetch, sent } = fakeFetch([
      json({ images: [{ url: "data:image/png;base64,AQID" }] }),
    ]);
    const result = await falImageClient({
      endpoint: "another/image/model",
      fetch,
      key: "k",
    }).generate(CALL);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://fal.run/another/image/model");
    expect(result.image.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.model).toBe("another/image/model");
  });

  it("raises the provider's refusal with its status", async () => {
    const { fetch } = fakeFetch([
      new Response('{"detail":"Exhausted balance"}', { status: 403 }),
    ]);
    const call = falImageClient({ fetch, key: "k" }).generate(CALL);
    await expect(call).rejects.toThrow(ModelRequestError);
    await expect(call).rejects.toMatchObject({ status: 403 });
    await expect(call).rejects.toThrow("Exhausted balance");
  });

  it("raises an answer with no files, and a file that cannot be fetched", async () => {
    const empty = fakeFetch([json({ images: [] })]);
    await expect(
      falImageClient({ fetch: empty.fetch, key: "k" }).generate(CALL)
    ).rejects.toThrow("no files");
    const gone = fakeFetch([
      json({ images: [{ url: "https://files.example/gone.png" }] }),
      new Response("gone", { status: 404 }),
    ]);
    await expect(
      falImageClient({ fetch: gone.fetch, key: "k" }).generate(CALL)
    ).rejects.toMatchObject({ status: 404 });
  });

  it("is unavailable without a key, says why, and sends nothing", async () => {
    const { fetch, sent } = fakeFetch([]);
    const client = falImageClient({ fetch });
    expect(client.availability()).toEqual({
      available: false,
      reason:
        "No fal API key was supplied, so this model cannot be called. Add a key to use it.",
    });
    await expect(client.generate(CALL)).rejects.toThrow(ModelRequestError);
    expect(sent).toEqual([]);
  });
});

describe("the fal vector client", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const place = () =>
    json({
      file_url: "https://storage.example/reference-1.png",
      upload_url: "https://put.example/reference-1.png?signed=1",
    });
  const stored = () => new Response(null, { status: 200 });

  it("puts the reference on fal's storage, then asks for one SVG at its address", async () => {
    const { fetch, sent } = fakeFetch([
      place(),
      stored(),
      json({ images: [{ url: "https://files.example/sheet.svg" }] }),
      new Response(svg, {
        headers: { "content-type": "image/svg+xml" },
        status: 200,
      }),
    ]);
    const result = await falVectorClient({
      fetch,
      key: "test-key",
      quality: "medium",
    }).generate(CALL);
    // The model fetches its reference itself and refuses one sent inline.
    expect(sent[0]).toMatchObject({
      body: { content_type: "image/png", file_name: "reference-1.png" },
      headers: {
        Authorization: "Key test-key",
        "X-Fal-Object-Lifecycle": '{"expiration_duration_seconds":3600}',
      },
      method: "POST",
      url: "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
    });
    // The bytes go to a signed address, and the key does not go with them.
    expect(sent[1]).toMatchObject({
      headers: { "Content-Type": "image/png" },
      method: "PUT",
      url: "https://put.example/reference-1.png?signed=1",
    });
    expect(sent[1]?.headers).not.toHaveProperty("Authorization");
    expect(sent[2]).toMatchObject({
      body: {
        aspect_ratio: "3:2",
        image_urls: ["https://storage.example/reference-1.png"],
        num_images: 1,
        prompt: "Draw a sheet.",
        quality: "medium",
      },
      headers: { Authorization: "Key test-key" },
      url: "https://fal.run/ideogram/vector/text-to-vector",
    });
    expect(result.svg).toBe(svg);
    expect(result.model).toBe("ideogram/vector/text-to-vector");
  });

  it("calls no model when the reference cannot be stored, and says which step failed", async () => {
    const refused = fakeFetch([new Response("no room", { status: 403 })]);
    await expect(
      falVectorClient({ fetch: refused.fetch, key: "k" }).generate(CALL)
    ).rejects.toThrow(
      "fal's storage answered 403 when asked for a place to put a picture: no room"
    );
    expect(refused.sent).toHaveLength(1);

    const dropped = fakeFetch([place(), new Response("gone", { status: 500 })]);
    await expect(
      falVectorClient({ fetch: dropped.fetch, key: "k" }).generate(CALL)
    ).rejects.toThrow("fal's storage answered 500 when sent a picture: gone");
    expect(dropped.sent).toHaveLength(2);

    const nowhere = fakeFetch([json({})]);
    await expect(
      falVectorClient({ fetch: nowhere.fetch, key: "k" }).generate(CALL)
    ).rejects.toThrow("fal's storage gave no address to put a picture at.");
  });
});

describe("model strategies", () => {
  let style: StyleReference;
  const hidden = withoutCharacters(lato, [0xe9, 0xf1]);
  const { targets } = planCharacters(hidden, [0xe9, 0xf1]);

  beforeAll(() => {
    style = analyseStyle(lato);
  });

  it("report themselves unavailable with the reason, and the runner tries nothing else", async () => {
    const withoutKey = imageModelStrategy({
      client: falImageClient({}),
      codec: nodeImageCodec,
    });
    expect(withoutKey.availability()).toMatchObject({
      available: false,
      reason: expect.stringContaining("No fal API key"),
    });
    const withoutClient = vectorModelStrategy({ codec: nodeImageCodec });
    expect(withoutClient.availability()).toEqual({
      available: false,
      reason: "No vector model is configured.",
    });
    const progress: StageProgress[] = [];
    const run = runGeneration({
      face: hidden,
      faceId: "lato",
      onProgress: (event) => progress.push(event),
      strategy: withoutKey,
      style,
      targets,
    });
    await expect(run).rejects.toThrow(StrategyUnavailableError);
    await expect(run).rejects.toThrow("No fal API key");
    // Generate started and nothing finished: no other strategy stood in.
    expect(progress).toEqual([{ stage: "generate", status: "started" }]);
    await expect(
      withoutClient.generate({ face: hidden, style, targets })
    ).rejects.toThrow(StrategyUnavailableError);
  });

  it("send the reference sheet and a prompt that names every cell", async () => {
    const calls: { prompt: string; reference: EncodedFile | undefined }[] = [];
    const strategy = vectorModelStrategy({
      client: {
        availability: () => ({ available: true }),
        generate: (made) => {
          calls.push({
            prompt: made.prompt,
            reference: made.referenceImages[0],
          });
          return Promise.resolve({
            latencyMs: 12,
            model: "test-double",
            parameters: { quality: "low" },
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
          });
        },
        model: "test-double",
      },
      clock: () => new Date("2026-11-10T12:00:00.000Z"),
      codec: nodeImageCodec,
      maxSize: 512,
    });
    const output = await strategy.generate({ face: hidden, style, targets });
    const [call] = calls;
    expect(call?.prompt).toContain("2 columns and 1 row");
    expect(call?.prompt).toContain(
      "Row 1, left to right: é (U+00E9)  ñ (U+00F1)"
    );
    expect(call?.prompt).toContain("Lato");
    expect(call?.reference?.mediaType).toBe("image/png");
    const reference = await nodeImageCodec.decode(
      call?.reference ?? { bytes: new Uint8Array(), mediaType: "" }
    );
    expect(reference.width).toBe(510);
    expect(output).toMatchObject({
      createdAt: "2026-11-10T12:00:00.000Z",
      producedBy: "vector-model",
      raw: { kind: "sheet-svg" },
      recorded: false,
      usage: { latencyMs: 12, model: "test-double" },
    });
    // What the model was shown is kept, as SVG, for the record.
    expect(output.sent?.referenceSheet).toContain("<svg");
    expect(output.sent?.prompt).toBe(call?.prompt);
  });
});

describe("the recorded run strategy", () => {
  const characters = [..."RGagk2"];
  let files: Map<string, Uint8Array>;
  let style: StyleReference;

  beforeAll(async () => {
    files = new Map([["sheet.png", await syntheticSheetPng(lato, characters)]]);
    style = analyseStyle(lato);
  });

  const replay = (manifest: ReturnType<typeof syntheticManifest>) => {
    const [recorded] = loadRecordedRuns(JSON.stringify(manifest), files);
    if (!recorded) {
      throw new Error("The manifest has one output.");
    }
    const targets = recordedTargets(recorded, lato);
    return runGeneration({
      codec: nodeImageCodec,
      face: lato,
      faceId: "lato",
      holdouts: new Map<string, GlyphShape>(
        targets.map((target) => [target.key, glyphOf(lato, target.text)])
      ),
      newId: () => "replay-1",
      strategy: recordedRunStrategy(recorded),
      style,
      targets,
    });
  };

  it("marks everything it produces as recorded, with the time and model of the real call", async () => {
    // The sheet is this test's own drawing. The manifest stands in for one a
    // model made, to check what a real recording's candidates would carry.
    const run = await replay(
      syntheticManifest(characters, {
        costUsd: 0.04,
        latencySeconds: 9.86,
        model: "example/model-under-test",
        name: "low",
        synthetic: false,
      })
    );
    expect(run.candidates).toHaveLength(6);
    for (const candidate of run.candidates) {
      expect(candidate.provenance).toEqual({
        createdAt: "2026-11-10T09:30:00.000Z",
        model: "example/model-under-test",
        origin: "generated",
        recorded: true,
        runId: "synthetic-sheet-1#low",
        strategy: "image-model",
      });
      // The face has these characters, so each candidate redraws one.
      expect(candidate.replaces?.kind).toBe("source");
      expect(candidate.id.startsWith("replay-1:")).toBe(true);
    }
    expect(run.record).toMatchObject({
      costUsd: 0.04,
      model: "example/model-under-test",
      modelLatencyMs: 9860,
      producedBy: "image-model",
      recorded: true,
      runId: "synthetic-sheet-1#low",
      strategy: { kind: "recorded-run" },
    });
  });

  it("never attributes a synthetic sheet to a model", async () => {
    const run = await replay(syntheticManifest(characters));
    for (const candidate of run.candidates) {
      expect(candidate.provenance).toEqual({
        createdAt: "2026-11-10T09:30:00.000Z",
        origin: "generated",
        recorded: true,
        runId: "synthetic-sheet-1#image-model",
        strategy: "synthetic-sheet",
      });
    }
    expect(run.record.model).toBeUndefined();
    expect(run.record.costUsd).toBeUndefined();
  });

  it("runs every stage on the sheet and recovers the glyphs that were drawn", async () => {
    const run = await replay(syntheticManifest(characters));
    expect(run.record.stages.map((stage) => stage.stage)).toEqual([
      ...RUN_STAGES,
    ]);
    expect(
      run.record.stages.map((stage) => [stage.stage, stage.status])
    ).toEqual([
      ["generate", "finished"],
      ["extract", "finished"],
      ["normalise", "finished"],
      ["compose", "finished"],
      ["validate", "finished"],
      ["refine", "finished"],
      ["integrate", "finished"],
    ]);
    expect(run.artefacts.extraction?.glyphs).toHaveLength(6);
    expect(run.artefacts.extraction?.glyphs[0]?.bitmap).toBeDefined();
    expect(run.artefacts.fit?.basis).toBe("height-model");
    expect(run.artefacts.drafts).toHaveLength(6);
    expect(run.artefacts.refined).toHaveLength(6);
    for (const evaluation of run.evaluations.values()) {
      // The sheet shows the face's own glyphs at 186 pixels to the em, so
      // what comes back should be the same shapes, traced. A stem is about
      // 17 pixels there, and half a pixel lost on each side of it is 6%.
      expect(evaluation.scores.shape, evaluation.key).toBeGreaterThan(0.9);
      expect(evaluation.verdict, evaluation.key).toBe("pass");
      expect(evaluation.madeBy).toContain(
        "traced from the pixels of sheet cell"
      );
    }
  });

  it("uses only the cells that were asked for when the sheet holds more", async () => {
    // Two rows of three are on the sheet. Only the first four are targets.
    const manifest = syntheticManifest(characters.slice(0, 4));
    const run = await replay({
      ...manifest,
      layout: { columns: 3, rows: 2 },
    });
    expect(run.candidates.map((candidate) => candidate.characters)).toEqual([
      [0x52],
      [0x47],
      [0x61],
      [0x67],
    ]);
    expect(run.artefacts.extraction?.report.extra).toHaveLength(2);
  });

  it("says which targets the recorded sheet never drew", async () => {
    const [recorded] = loadRecordedRuns(
      JSON.stringify(syntheticManifest(characters)),
      files
    );
    if (!recorded) {
      throw new Error("The manifest has one output.");
    }
    const run = await runGeneration({
      codec: nodeImageCodec,
      face: lato,
      faceId: "lato",
      strategy: recordedRunStrategy(recorded),
      style,
      targets: [
        ...recordedTargets(recorded, lato),
        ...planCharacters(withoutCharacters(lato, [0xe9]), [0xe9]).targets,
      ],
    });
    expect(run.record.unmade).toEqual([
      { key: "u+00e9", reason: "The recorded run did not draw this glyph." },
    ]);
  });

  it("refuses a manifest that is malformed or names a missing file", () => {
    const manifest = syntheticManifest(characters);
    expect(() => loadRecordedRuns("{", files)).toThrow(RecordedRunError);
    expect(() =>
      loadRecordedRuns(JSON.stringify({ ...manifest, outputs: [] }), files)
    ).toThrow("lists no outputs");
    expect(() =>
      loadRecordedRuns(
        JSON.stringify({ ...manifest, layout: undefined }),
        files
      )
    ).toThrow("no layout with a column count");
    expect(() => loadRecordedRuns(JSON.stringify(manifest), new Map())).toThrow(
      "sheet.png, which is not among its files"
    );
  });

  it("needs a decoder for a picture and says so", async () => {
    const [recorded] = loadRecordedRuns(
      JSON.stringify(syntheticManifest(characters)),
      files
    );
    if (!recorded) {
      throw new Error("The manifest has one output.");
    }
    const run = runGeneration({
      face: lato,
      faceId: "lato",
      strategy: recordedRunStrategy(recorded),
      style,
      targets: recordedTargets(recorded, lato),
    });
    await expect(run).rejects.toThrow(MissingDecoderError);
    await expect(run).rejects.toThrow("needs an image decoder");
  });
});
