import { describe, expect, it } from "vitest";

import {
  deserializeEmbedding,
  rankBySimilarity,
  serializeEmbedding,
  topK,
} from "../../embeddings/text";

describe("serializeEmbedding / deserializeEmbedding", () => {
  it("roundtrips a number array", () => {
    const v = [0.1, -0.2, 0.3, 1, -1, 0];
    expect(deserializeEmbedding(serializeEmbedding(v))).toEqual(v);
  });

  it("rejects non-array JSON", () => {
    expect(() => deserializeEmbedding(`{"a":1}`)).toThrow(
      /expected number array/
    );
  });

  it("coerces string-encoded numbers via Number()", () => {
    expect(deserializeEmbedding(`["1","2","3"]`)).toEqual([1, 2, 3]);
  });
});

describe("rankBySimilarity", () => {
  it("ranks rows by descending cosine similarity and slices to topK", () => {
    const query = [1, 0];
    const rows = [
      { embedding: serializeEmbedding([0, 1]), id: "a" }, // orthogonal
      { embedding: serializeEmbedding([1, 0]), id: "b" }, // identical
      { embedding: serializeEmbedding([0.5, 0.5]), id: "c" },
    ];

    const ranked = rankBySimilarity(query, rows, 2);

    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.row.id).toBe("b");
    expect(ranked[1]?.row.id).toBe("c");
  });

  it("returns an empty array when given no rows", () => {
    expect(rankBySimilarity([1, 0], [], 5)).toEqual([]);
  });
});

describe("topK (raw-vector ranking)", () => {
  it("ranks candidates by descending cosine similarity and slices to k", () => {
    const query = [1, 0];
    const candidates = [
      { embedding: [0, 1], item: { id: "a" } }, // orthogonal
      { embedding: [1, 0], item: { id: "b" } }, // identical
      { embedding: [0.5, 0.5], item: { id: "c" } },
    ];

    const ranked = topK(query, candidates, 2);

    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.item.id).toBe("b");
    expect(ranked[1]?.item.id).toBe("c");
    expect(ranked[0]?.score).toBeCloseTo(1, 6);
  });

  it("returns an empty array when given no candidates", () => {
    expect(topK([1, 0], [], 5)).toEqual([]);
  });
});
