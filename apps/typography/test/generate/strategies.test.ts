import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import {
  DEFAULT_SCOPE_KEY,
  missingForLanguage,
  missingInScope,
  scopeFromKey,
  scopeOptions,
} from "~/generate/missing-characters";
import {
  comparisonNote,
  entryLabel,
  listRecordedRuns,
} from "~/generate/recorded-catalogue";
import { strategyLabel, strategyOptions } from "~/generate/strategies";
import { styleFacts } from "~/generate/style-facts";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { analyseStyle } from "~/generation/style/reference";
import type { Classifier } from "~/unicode/coverage";
import { findLanguage } from "~/unicode/languages";
import { fontBytes } from "../helpers/fixtures";
import { fixtureFetch } from "./helpers/session";

const RECORDED = { available: true } as const;

describe("the strategies on offer", () => {
  it("offers four, and the models cannot run without a key, in the strategy's own words", () => {
    const options = strategyOptions(
      { codec: nodeImageCodec, providerKey: "" },
      RECORDED
    );
    expect(options.map((option) => option.kind)).toEqual([
      "procedural",
      "image-model",
      "vector-model",
      "recorded-run",
    ]);
    expect(options.map((option) => option.availability.available)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    const [, image, vector] = options;
    expect(image?.model).toBe("openai/gpt-image-2.6/flare/edit");
    expect(vector?.model).toBe("ideogram/vector/text-to-vector");
    expect(image?.availability).toMatchObject({
      reason: expect.stringContaining("No fal API key was supplied"),
    });
  });

  it("makes the models available once a key is pasted, and ignores a blank one", () => {
    const available = (providerKey: string) =>
      strategyOptions({ codec: nodeImageCodec, providerKey }, RECORDED).map(
        (option) => option.availability.available
      );
    expect(available("a-key")).toEqual([true, true, true, true]);
    expect(available("   ")).toEqual([true, false, false, true]);
  });

  it("passes on why a recorded run cannot be replayed", () => {
    const recorded = { available: false, reason: "None is served." } as const;
    const options = strategyOptions(
      { codec: nodeImageCodec, providerKey: "" },
      recorded
    );
    expect(options.at(-1)?.availability).toEqual(recorded);
  });

  it("names strategies as provenance records them", () => {
    expect(strategyLabel("vector-model")).toBe("Vector model");
    expect(strategyLabel("synthetic-sheet")).toBe("Synthetic sheet, no model");
    expect(strategyLabel("something-new")).toBe("something-new");
  });
});

describe("the recorded runs served with the app", () => {
  it("reports a run it cannot read and still lists the others", async () => {
    const catalogue = await listRecordedRuns(async (address) => {
      if (address.endsWith("index.json")) {
        return Response.json(["broken", "2026-11-10-latin-holdout"]);
      }
      return address.includes("/broken/")
        ? new Response("{ not json")
        : await fixtureFetch(address);
    }, "/");
    expect(catalogue.entries).toHaveLength(2);
    expect(catalogue.problems).toEqual([
      "broken: The recorded-run manifest is not valid JSON.",
    ]);
    expect(catalogue.entries.map(entryLabel)).toEqual([
      "2026-11-10-latin-holdout, image-model: openai/gpt-image-2.6/flare/edit",
      "2026-11-10-latin-holdout, vector-model: ideogram/vector/text-to-vector",
    ]);
  });

  it("says when a run's glyphs cannot be compared with a face's own", async () => {
    const { entries } = await listRecordedRuns(fixtureFetch, "/");
    const lato = { familyName: "Lato", fullName: "Lato Regular" };
    const sofia = { familyName: "Sofia Sans", fullName: "Sofia Sans Regular" };
    const holdout = entries.find(
      (entry) => entry.directory === "2026-11-10-latin-holdout"
    );
    const storefront = entries.find(
      (entry) => entry.directory === "2026-11-10-storefront-completion"
    );
    if (!(holdout && storefront)) {
      throw new Error("The fixture runs are not all listed.");
    }
    expect(comparisonNote(holdout, lato)).toBeUndefined();
    expect(comparisonNote(holdout, sofia)).toContain(
      "made from Lato Regular, not from Sofia Sans Regular"
    );
    expect(comparisonNote(storefront, lato)).toContain("not made from a font");
  });
});

describe("what a face is missing", () => {
  const has = new Set([0x61, 0x62, 0xe9]);
  const classify: Classifier = (character) => {
    if (has.has(character)) {
      return "source";
    }
    return character === 0x63 ? "candidate" : "missing";
  };

  it("lists a scope's characters the face lacks and no candidate offers", () => {
    const missing = missingInScope(
      { codePoints: [0x61, 0x63, 0x64, 0x65], kind: "characters" },
      classify
    );
    expect(missing).toEqual([0x64, 0x65]);
  });

  it("lists a language's missing characters, the required ones first", async () => {
    const french = await findLanguage("fr");
    if (!french) {
      throw new Error("The language data has no French.");
    }
    const missing = missingForLanguage(french, classify);
    expect(missing).not.toContain(0xe9);
    expect(missing).toContain(0xe8);
    const firstAuxiliary = missing.findIndex((character) =>
      french.auxiliary.includes(character)
    );
    const lastRequired = missing.findLastIndex((character) =>
      french.required.includes(character)
    );
    expect(lastRequired).toBeLessThan(firstAuxiliary);
  });

  it("offers every writing system once and reads each option back", () => {
    const options = scopeOptions();
    expect(options[0]).toEqual({ label: "Latin", value: DEFAULT_SCOPE_KEY });
    expect(new Set(options.map((option) => option.value)).size).toBe(
      options.length
    );
    for (const option of options) {
      expect(scopeFromKey(option.value)).toBeDefined();
    }
    expect(scopeFromKey("script:Nope")).toBeUndefined();
  });
});

describe("the style reference as facts", () => {
  it("prints each measured line with where the figure came from", () => {
    const facts = styleFacts(
      analyseStyle(harfBuzzReader.open(fontBytes("lato")))
    );
    const capHeight = facts.find((fact) => fact.label === "Cap height");
    expect(Number(capHeight?.value)).toBeGreaterThan(1300);
    expect(capHeight?.note).toBe("Measured from the source font's letters");
    expect(facts.map((fact) => fact.label)).toContain("Upright stems");
    expect(new Set(facts.map((fact) => fact.label)).size).toBe(facts.length);
  });
});
