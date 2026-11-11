/** A build that is given its modified time gives the same bytes every time. */
import { beforeAll, describe, expect, it } from "vitest";
import type { FontBuilder } from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { fontBytes, TRIANGLE } from "../helpers/fixtures";
import { variableRequestFor, wedgeMaster } from "./helpers/masters";
import { requestFor } from "./helpers/requests";

const NOON = "2026-11-10T12:00:00.000Z";
const LATER = "2026-11-10T12:00:01.000Z";
/** Seconds from 1 January 1904, which a font counts from, to 1 January 1970. */
const FONT_EPOCH = 2_082_844_800;
const HEAD = 0x68_65_61_64;
const DIRECTORY_START = 12;
const RECORD_SIZE = 16;
const MODIFIED_AT = 28;
/** Two rebuilds of a variable font, beside every other suite, can outlast the default limit. */
const VARIABLE_BUILDS_TIMEOUT = 180_000;

/** The modified time in a font's head table, in seconds since 1970. */
const modifiedOf = (font: Uint8Array): number => {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = view.getUint16(4);
  for (let table = 0; table < tables; table += 1) {
    const record = DIRECTORY_START + table * RECORD_SIZE;
    if (view.getUint32(record) === HEAD) {
      const offset = view.getUint32(record + 8);
      return Number(view.getBigInt64(offset + MODIFIED_AT)) - FONT_EPOCH;
    }
  }
  throw new Error("The font has no head table.");
};

describe("a build's modified time", () => {
  let builder: FontBuilder;
  const lato = fontBytes("lato");
  const sofia = fontBytes("sofia");
  const request = requestFor(lato, {
    added: [
      {
        advance: 1000,
        characters: [0xe0_00],
        key: "triangle",
        name: "triangle.added",
        outline: TRIANGLE,
        provenance: { origin: "manual" },
      },
    ],
    familyName: "Atlas Sans",
  });

  beforeAll(async () => {
    builder = await nodeFontBuilder();
  });

  it("is written as given, and the same request then gives the same bytes", async () => {
    const first = await builder.build({ ...request, modifiedAt: NOON });
    const second = await builder.build({ ...request, modifiedAt: NOON });
    expect(modifiedOf(first.bytes)).toBe(Date.parse(NOON) / 1000);
    expect(second.bytes).toEqual(first.bytes);
  });

  it("gives different bytes for a different time", async () => {
    const first = await builder.build({ ...request, modifiedAt: NOON });
    const later = await builder.build({ ...request, modifiedAt: LATER });
    expect(modifiedOf(later.bytes)).toBe(Date.parse(LATER) / 1000);
    expect(later.bytes).not.toEqual(first.bytes);
  });

  it("holds for a subset and for a pinned instance", async () => {
    const subset = {
      ...request,
      modifiedAt: NOON,
      subset: { characters: [0x41, 0x42, 0xe0_00] },
    };
    expect((await builder.build(subset)).bytes).toEqual(
      (await builder.build(subset)).bytes
    );
    const pinned = requestFor(sofia, {
      location: { wght: 700 },
      modifiedAt: NOON,
      styleName: "Bold",
    });
    const built = await builder.build(pinned);
    expect(modifiedOf(built.bytes)).toBe(Date.parse(NOON) / 1000);
    expect((await builder.build(pinned)).bytes).toEqual(built.bytes);
  });

  it("is the time of the build when the request gives none", async () => {
    const before = Math.floor(Date.now() / 1000);
    const built = await builder.build(request);
    expect(modifiedOf(built.bytes)).toBeGreaterThanOrEqual(before);
  });

  it(
    "holds for a rebuilt variable font",
    async () => {
      const masters = [wedgeMaster(300, "Light"), wedgeMaster(700, "Bold")];
      const variable = variableRequestFor(sofia, masters, {
        modifiedAt: LATER,
      });
      const first = await builder.buildVariable(variable);
      const second = await builder.buildVariable(variable);
      expect(modifiedOf(first.bytes)).toBe(Date.parse(LATER) / 1000);
      expect(second.bytes).toEqual(first.bytes);
    },
    VARIABLE_BUILDS_TIMEOUT
  );

  it("refuses a time it cannot read, in plain words", async () => {
    await expect(
      builder.build({ ...request, modifiedAt: "yesterday" })
    ).rejects.toThrow("The modified time yesterday is not an ISO 8601 time.");
  });
});
