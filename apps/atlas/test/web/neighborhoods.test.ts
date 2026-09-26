import { describe, expect, it } from "vitest";
import { findNeighborhoods } from "../../src/web/neighborhoods";
import { fileRelationships } from "../../src/web/relationships";
import type { AtlasFile } from "../../src/web/types";

const file = (id: string): AtlasFile => ({
  directory: "src",
  id,
  incoming: 0,
  kind: "source",
  outgoing: 0,
  path: `src/${id}.ts`,
  x: 0,
  y: 0,
});
const triangle = (a: string, b: string, c: string) => [
  { source: a, target: b },
  { source: b, target: c },
  { source: c, target: a },
];

describe("evidence-based neighborhoods", () => {
  it("separates strongly linked groups even when they share a directory and a weak bridge", () => {
    const files = ["a", "b", "c", "d", "e", "f", "alone"].map(file);
    const edges = [
      ...triangle("a", "b", "c"),
      ...triangle("d", "e", "f"),
      { source: "c", target: "d" },
    ];
    const relationships = fileRelationships(
      files.map((f) => f.id),
      edges,
      new Map()
    );
    expect(
      findNeighborhoods(files, relationships).map((n) => n.members)
    ).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });
  it("recognizes shared concept evidence without inventing imports or duplicate participation", () => {
    const files = [file("a"), file("b"), file("alone")];
    const relations = fileRelationships(
      files.map((f) => f.id),
      [],
      new Map([
        ["a", ["contract", "contract"]],
        ["b", ["contract"]],
      ])
    );
    expect(relations).toHaveLength(1);
    expect(relations[0]?.imports).toBe(0);
    expect(findNeighborhoods(files, relations)[0]).toMatchObject({
      imports: 0,
      members: ["a", "b"],
      sharedConcepts: 1,
    });
  });
  it("does not cluster files merely because their directories match", () => {
    expect(findNeighborhoods([file("a"), file("b")], [])).toEqual([]);
  });
  it("preserves memberships and labels when files, imports and concepts arrive in a different order", () => {
    const files = ["a", "b", "c", "d", "e", "f"].map(file);
    const edges = [...triangle("a", "b", "c"), ...triangle("d", "e", "f")];
    const concepts = new Map([
      ["a", ["z", "x"]],
      ["b", ["x", "z"]],
    ]);
    const forward = fileRelationships(
      files.map((f) => f.id),
      edges,
      concepts
    );
    const reverse = fileRelationships(
      files.map((f) => f.id).reverse(),
      edges.reverse(),
      new Map([...concepts].reverse().map(([k, v]) => [k, v.reverse()]))
    );
    expect(forward).toEqual(reverse);
    expect(findNeighborhoods(files, forward)).toEqual(
      findNeighborhoods(files.reverse(), reverse)
    );
  });
  it("does not turn a widely shared concept into stronger pair evidence than a specific concept", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const broad = fileRelationships(
      ids,
      [],
      new Map(ids.map((id) => [id, ["common"]]))
    );
    const specific = fileRelationships(
      ids,
      [],
      new Map([
        ["a", ["specific"]],
        ["b", ["specific"]],
      ])
    );
    expect(broad[0]?.attraction).toBeLessThan(specific[0]?.attraction ?? 0);
  });
});
