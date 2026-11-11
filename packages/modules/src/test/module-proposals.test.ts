import { describe, expect, it } from "vitest";

import {
  applyModuleSourceChanges,
  moduleSourceChanges,
  validateModuleSourceProposal,
} from "../proposals";
import { ModuleSourceAdmissionError } from "../source";
import { VALID_MANIFEST } from "./helpers/module-fixture";

const snapshot = {
  "foundry.module.json": JSON.stringify(VALID_MANIFEST),
  "src/a.ts": "a",
  "src/b.ts": "b",
};

describe("Module source proposals", () => {
  it("lists changed and removed files, and applies them back", () => {
    const proposed = {
      "foundry.module.json": snapshot["foundry.module.json"],
      "src/a.ts": "a2",
      "src/c.ts": "c",
    };
    const changes = moduleSourceChanges(snapshot, proposed);
    expect(changes).toEqual({
      "src/a.ts": "a2",
      "src/b.ts": null,
      "src/c.ts": "c",
    });
    expect(applyModuleSourceChanges(snapshot, changes)).toEqual(proposed);
    expect(moduleSourceChanges(snapshot, snapshot)).toEqual({});
  });

  it("treats a path named __proto__ as an ordinary file", () => {
    const files = (entries: [string, string][]) => Object.fromEntries(entries);
    const before = files([["__proto__", "old"]]);
    const after = files([["__proto__", "new"]]);

    const edited = moduleSourceChanges(before, after);
    const added = moduleSourceChanges({}, after);
    const removed = moduleSourceChanges(before, {});
    expect(Object.entries(edited)).toEqual([["__proto__", "new"]]);
    expect(Object.entries(added)).toEqual([["__proto__", "new"]]);
    expect(Object.entries(removed)).toEqual([["__proto__", null]]);
    for (const changes of [edited, added, removed]) {
      expect(Object.getPrototypeOf(changes)).toBe(Object.prototype);
    }

    expect(Object.entries(applyModuleSourceChanges(before, edited))).toEqual([
      ["__proto__", "new"],
    ]);
    expect(Object.entries(applyModuleSourceChanges({}, added))).toEqual([
      ["__proto__", "new"],
    ]);
    const emptied = applyModuleSourceChanges(before, removed);
    expect(Object.entries(emptied)).toEqual([]);
    expect(Object.getPrototypeOf(emptied)).toBe(Object.prototype);
  });

  it("admits the source a proposal would produce", () => {
    expect(() =>
      validateModuleSourceProposal(snapshot, { "src/a.ts": "a2" })
    ).not.toThrow();
    expect(() =>
      validateModuleSourceProposal(snapshot, { "../escape.ts": "x" })
    ).toThrow(ModuleSourceAdmissionError);
    expect(() =>
      validateModuleSourceProposal(
        snapshot,
        { "src/big.ts": "x".repeat(10) },
        {
          maxBytes: 1_000_000,
          maxFileCodeUnits: 5,
          maxFiles: 10,
          maxPathCharacters: 100,
        }
      )
    ).toThrow("UTF-16 code units");
  });

  it("refuses a proposal that removes or breaks the Manifest", () => {
    expect(() =>
      validateModuleSourceProposal(snapshot, { "foundry.module.json": null })
    ).toThrow("The proposal removes foundry.module.json.");
    expect(() =>
      validateModuleSourceProposal(snapshot, { "foundry.module.json": "{" })
    ).toThrow("foundry.module.json is not a valid Manifest");
  });
});
