/**
 * The engine client against the real engine server, joined by a message
 * channel in place of a worker boundary, and against a scripted worker for
 * the failures a real engine does not produce on demand.
 */
import { afterAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { BuildError, type FontBuilder } from "~/packaging/building";
import {
  createEngineClient,
  type EngineStatus,
} from "~/packaging/engine/client";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { fontBytes } from "../helpers/fixtures";
import { variableRequestFor, wedgeMaster } from "./helpers/masters";
import { charactersOf, requestFor } from "./helpers/requests";
import { channelWorker, ScriptedWorker } from "./helpers/workers";

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("The call should have been rejected.");
    },
    (error: unknown) => error as Error
  );

describe("the engine client over a message channel", () => {
  const lato = fontBytes("lato");
  const handedOver: Uint8Array[] = [];
  /** The real engine, remembering the bytes it returned so the test can see them leave. */
  const recordingEngine = async (): Promise<FontBuilder> => {
    const engine = await nodeFontBuilder();
    return {
      ...engine,
      build: async (request) => {
        const built = await engine.build(request);
        handedOver.push(built.bytes);
        return built;
      },
    };
  };
  let spawned = 0;
  const client = createEngineClient(() => {
    spawned += 1;
    return channelWorker(recordingEngine);
  });
  const statuses: EngineStatus[] = [];
  client.subscribe((status) => statuses.push(status));

  afterAll(() => client.dispose());

  it("does not start the engine until it is used", () => {
    expect(client.status()).toBe("idle");
    expect(spawned).toBe(0);
    expect(statuses).toEqual([]);
  });

  it("starts on the first call and answers queued calls in order", async () => {
    const finished: string[] = [];
    const note = (label: string) => () => finished.push(label);
    const subset = { characters: charactersOf("fi") };
    const calls = [
      client.build(requestFor(lato, { subset })).finally(note("build")),
      client.describeLayout(lato).finally(note("layout")),
      client.validate(lato).finally(note("validate")),
      client
        .build(requestFor(lato, { flavor: "woff2", subset }))
        .finally(note("woff2")),
    ] as const;
    expect(client.status()).toBe("starting");
    const [built, layout, validation, packed] = await Promise.all(calls);

    expect(spawned).toBe(1);
    expect(statuses).toEqual(["starting", "ready"]);
    expect(finished).toEqual(["build", "layout", "validate", "woff2"]);
    expect(harfBuzzReader.open(built.bytes).shape("fi").glyphs).toHaveLength(1);
    expect(built.characterCount).toBe(2);
    expect(layout.glyphNames).toHaveLength(3023);
    expect(validation.loadable).toBe(true);
    expect(packed.bytes.byteLength).toBeLessThan(built.bytes.byteLength);
  });

  it("copies the caller's bytes and takes over the engine's", () => {
    expect(lato.byteLength).toBe(656_568);
    expect(harfBuzzReader.open(lato).description.familyName).toBe("Lato");
    expect(handedOver).toHaveLength(2);
    expect(handedOver.map((bytes) => bytes.byteLength)).toEqual([0, 0]);
  });

  it("raises a BuildError with the engine's message and keeps working", async () => {
    const error = await rejection(
      client.build(requestFor(new Uint8Array([1, 2, 3, 4])))
    );
    expect(error).toBeInstanceOf(BuildError);
    expect(error.message).toBe(
      "The source file does not open as a font: Not a TrueType or OpenType font (not enough data)"
    );
    expect(client.status()).toBe("ready");
    expect((await client.validate(lato)).loadable).toBe(true);
  });

  it("makes a blank font and refuses a variable font across the channel", async () => {
    const blank = await client.blankFont({
      familyName: "Storefront",
      metrics: { ascender: 800, descender: -200, lineGap: 0, unitsPerEm: 1000 },
      styleName: "Regular",
    });
    expect(harfBuzzReader.open(blank.bytes).description.familyName).toBe(
      "Storefront"
    );
    const error = await rejection(
      client.buildVariable(
        variableRequestFor(lato, [
          wedgeMaster(300, "Light"),
          wedgeMaster(700, "Bold"),
        ])
      )
    );
    expect(error).toBeInstanceOf(BuildError);
    expect(error.message).toBe(
      "The source font is not variable. A variable font is rebuilt from pinned instances of a variable font."
    );
    expect(lato.byteLength).toBe(656_568);
    expect(client.status()).toBe("ready");
  });

  it("stops listening when unsubscribed", () => {
    const seen: EngineStatus[] = [];
    const unsubscribe = client.subscribe((status) => seen.push(status));
    unsubscribe();
    client.dispose();
    expect(seen).toEqual([]);
    expect(client.status()).toBe("idle");
  });
});

describe("the engine client when the engine fails", () => {
  it("rejects waiting calls when the engine does not start, and starts again on the next call", async () => {
    let attempts = 0;
    const client = createEngineClient(() => {
      attempts += 1;
      return channelWorker(() =>
        attempts === 1
          ? Promise.reject(new Error("the runtime did not load"))
          : nodeFontBuilder()
      );
    });
    const statuses: EngineStatus[] = [];
    client.subscribe((status) => statuses.push(status));
    const lato = fontBytes("lato");
    const errors = await Promise.all([
      rejection(client.validate(lato)),
      rejection(client.describeLayout(lato)),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(BuildError);
      expect(error.message).toBe(
        "The font engine did not start (the runtime did not load). Try again."
      );
    }
    expect(statuses).toEqual(["starting", "failed"]);
    expect((await client.validate(lato)).loadable).toBe(true);
    expect(statuses).toEqual(["starting", "failed", "starting", "ready"]);
    expect(attempts).toBe(2);
    client.dispose();
  });

  it("rejects waiting calls when the worker crashes", async () => {
    const worker = new ScriptedWorker();
    const client = createEngineClient(() => worker);
    const call = rejection(client.validate(new Uint8Array(8)));
    worker.say({ kind: "ready" });
    expect(client.status()).toBe("ready");
    worker.crash("out of memory");
    expect((await call).message).toBe(
      "The font engine stopped (out of memory). Try again."
    );
    expect(client.status()).toBe("failed");
    expect(worker.terminated).toBe(true);
  });

  it("starts ahead of the first call when asked, and only once", () => {
    const workers: ScriptedWorker[] = [];
    const client = createEngineClient(() => {
      const worker = new ScriptedWorker();
      workers.push(worker);
      return worker;
    });
    client.start();
    client.start();
    expect(client.status()).toBe("starting");
    expect(workers).toHaveLength(1);
    expect(workers[0]?.posted).toEqual([]);
  });

  it("rejects waiting calls when it is disposed", async () => {
    const worker = new ScriptedWorker();
    const client = createEngineClient(() => worker);
    const call = rejection(client.validate(new Uint8Array(8)));
    client.dispose();
    expect((await call).message).toBe("The font engine was stopped.");
    expect(worker.terminated).toBe(true);
  });

  it("rejects a call it cannot send", async () => {
    const worker = new ScriptedWorker();
    worker.postMessage = () => {
      throw new Error("the request could not be cloned");
    };
    const client = createEngineClient(() => worker);
    const error = await rejection(client.validate(new Uint8Array(8)));
    expect(error).toBeInstanceOf(BuildError);
    expect(error.message).toBe(
      "The request could not be sent to the font engine (the request could not be cloned)."
    );
  });

  it("ignores messages from a worker it has already replaced", async () => {
    const workers: ScriptedWorker[] = [];
    const client = createEngineClient(() => {
      const worker = new ScriptedWorker();
      workers.push(worker);
      return worker;
    });
    const first = rejection(client.validate(new Uint8Array(8)));
    client.dispose();
    await first;
    const second = client.validate(new Uint8Array(8));
    const id = workers[1]?.posted[0]?.id ?? 0;
    const report = {
      characterCount: 1,
      glyphCount: 2,
      issues: [],
      loadable: true,
    };
    workers[0]?.say({ id, kind: "error", message: "stale" });
    workers[1]?.say({ id, kind: "result", value: report });
    expect(await second).toEqual(report);
  });
});
