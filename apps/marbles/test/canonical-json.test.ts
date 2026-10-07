import { createHash } from "node:crypto";
import { canonicalizeJson } from "@foundry/lib/json";
import { agent, schedule, step } from "@foundry/marbles";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { catalog } from "~/authoring/catalog";
import { jsonData } from "~/lib/state/json";

/**
 * Trigger keys, agent ids and monitor hashes are persisted, so the bytes they
 * are hashed from must never move. The pinned values were computed by
 * `stableJson`, the serializer `jsonData` + `canonicalizeJson` replaced.
 */

afterEach(() => {
  catalog.reset();
});

const literal = {
  a: undefined,
  b: 1,
  list: [undefined, "x", { y: [1, 2], z: null }],
  nested: { c: true, d: "é" },
  when: new Date(0),
};

it("serializes what a trigger's input may hold as it always has", () => {
  expect(canonicalizeJson(jsonData(literal))).toBe(
    '{"a":null,"b":1,"list":[null,"x",{"y":[1,2],"z":null}],"nested":{"c":true,"d":"é"},"when":{}}'
  );
  // Not pinned: the old serializer gave invalid JSON (`[null,]`) here, so
  // nothing persisted could depend on it.
  expect(canonicalizeJson(jsonData([Number.NaN, () => 1]))).toBe("[null,null]");
  expect(() => jsonData({ big: 1n })).toThrow(TypeError);
});

it("keeps the schedule key of an input holding undefined and a Date", () => {
  const shout = step("shout")
    .input(z.record(z.string(), z.unknown()))
    .do(() => 1);
  schedule(shout({}, literal)).every("1h");
  expect([...catalog.schedules.keys()]).toEqual(["shout-09e13586"]);
});

it("keeps a nameless agent's id", () => {
  // Built inside the test body, so no const name is inferred for it.
  const reviewer = agent({ prompt: "Review the diff", provider: "codex" });
  expect(reviewer.id).toBe("agent-04abd4e661bc0483");
  expect(
    createHash("sha256")
      .update(canonicalizeJson(["Review the diff", "codex", null]))
      .digest("hex")
  ).toBe("04abd4e661bc048320e982a4a4cfaa52b1bcad0e5687ed437c951a5d997b9865");
});
