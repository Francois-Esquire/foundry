import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AnnotationDocument,
  Mark,
} from "../../../lib/annotations/model.ts";
import { decodeShare, encodeShare } from "../../../lib/annotations/share.ts";

const BASE_URL =
  "https://example.com/foundry/marbles/foundation/api/?view=read#the-model";

function mark(kind: Mark["kind"] = "highlight", index = 0): Mark {
  const quote = "each run has its own result";
  return {
    anchor: { id: "the-model:p:abc:0", x: 0.3, y: 0.2 },
    color: "#c93848",
    id: `annotation-${index}`,
    kind,
    points:
      kind === "draw" || kind === "arrow"
        ? [
            { x: 0, y: 0 },
            { x: 15.57, y: -22.6 },
          ]
        : [],
    text:
      kind === "comment" || kind === "text"
        ? "A note with Unicode: café 日本語 🖊️"
        : "",
    ...(kind === "draw" || kind === "text"
      ? {}
      : {
          target: {
            segments: [
              {
                blockId: "the-model:p:abc:0",
                end: 10 + quote.length,
                prefix: "a workflow ",
                quote,
                start: 10,
                suffix: ". Run it again.",
              },
            ],
          },
        }),
  };
}

function document(...marks: Mark[]): AnnotationDocument {
  return { marks, version: 1 };
}

function rawPayload(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return `1r.${btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")}`;
}

function deterministicNoise(length: number): string {
  let seed = 17 + length;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 48_271) % 2_147_483_647;
    output += String.fromCharCode(33 + (seed % 90));
  }
  return output;
}

afterEach(() => vi.unstubAllGlobals());

describe("annotation share links", () => {
  it("round-trips all annotation types, Unicode, identities, and exact point coordinates", async () => {
    const state = document(
      ...(
        ["draw", "text", "highlight", "underline", "arrow", "comment"] as const
      ).map(mark)
    );
    const encoded = await encodeShare(state, BASE_URL);
    expect(encoded.url).toBeDefined();
    expect(await decodeShare(encoded.url ?? "")).toEqual({
      document: state,
      message: "Shared annotations loaded from this link.",
      status: "valid",
    });
    const url = new URL(encoded.url ?? "");
    expect(url.searchParams.get("view")).toBe("read");
    expect(url.hash).toBe("#the-model");
    expect(encoded.bytes).toBe(new TextEncoder().encode(url.href).byteLength);
  });

  it("distinguishes an absent share from an explicitly empty shared document", async () => {
    expect((await decodeShare(BASE_URL)).status).toBe("absent");
    const encoded = await encodeShare(document(), BASE_URL);
    expect((await decodeShare(encoded.url ?? "")).document).toEqual(document());
  });

  it("replaces a previous payload and preserves unrelated URL fields", async () => {
    const encoded = await encodeShare(document(mark()), `${BASE_URL}&ignored`);
    const again = await encodeShare(
      document(mark("comment")),
      encoded.url ?? BASE_URL
    );
    expect(new URL(again.url ?? "").searchParams.getAll("notes")).toHaveLength(
      1
    );
    expect((await decodeShare(again.url ?? "")).document).toEqual(
      document(mark("comment"))
    );
  });

  it("supports uncompressed fallback when native compression is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    const state = document(mark("comment"));
    const encoded = await encodeShare(state, BASE_URL);
    expect(
      new URL(encoded.url ?? "").searchParams.get("notes")?.startsWith("1r.")
    ).toBe(true);
    expect((await decodeShare(encoded.url ?? "")).document).toEqual(state);
  });

  it.each([
    "",
    "2g.abc",
    "1r.%",
    "1r.a",
    "1g.e30",
    rawPayload({ marks: [] }),
    rawPayload([["id", 2, "ffffff", "block", 0, 0, [], "", []]]),
  ])(
    "rejects malformed, unsupported, or invalid payloads %s",
    async (payload) => {
      const url = new URL(BASE_URL);
      url.searchParams.set("notes", payload);
      expect((await decodeShare(url.href)).status).toBe("invalid");
    }
  );

  it("rejects repeated parameters and oversized URLs", async () => {
    const encoded = await encodeShare(document(mark()), BASE_URL);
    const url = new URL(encoded.url ?? "");
    url.searchParams.append("notes", "1r.W10");
    expect((await decodeShare(url.href)).status).toBe("invalid");
    const long = new URL(BASE_URL);
    long.searchParams.set("notes", "a".repeat(8001));
    expect((await decodeShare(long.href)).status).toBe("invalid");
  });

  it("bounds decompression before parsing a gzip expansion bomb", async () => {
    const stream = new Blob([" ".repeat(1_000_001)])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    const payload = `1g.${btoa(String.fromCharCode(...compressed))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")}`;
    const url = new URL(BASE_URL);
    url.searchParams.set("notes", payload);
    expect(url.href.length).toBeLessThan(8000);
    expect((await decodeShare(url.href)).status).toBe("invalid");
  });

  it("never truncates an over-limit document or emits a misleading partial link", async () => {
    const state = document(
      ...Array.from({ length: 30 }, (_, index) => ({
        ...mark("text", index),
        text: deterministicNoise(2000 + index).slice(index),
      }))
    );
    const before = JSON.stringify(state);
    const encoded = await encodeShare(state, BASE_URL);
    expect(encoded.url).toBeUndefined();
    expect(encoded.qrReady).toBe(false);
    expect(encoded.bytes).toBeGreaterThan(8000);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("keeps common semantic annotation examples within the QR target", async () => {
    for (const state of [
      document(),
      document(mark()),
      document(
        ...Array.from({ length: 10 }, (_, index) => mark("highlight", index))
      ),
      document(mark("comment")),
      document(mark("arrow")),
    ]) {
      const result = await encodeShare(state, BASE_URL);
      expect(result.url).toBeDefined();
      expect(result.bytes).toBeLessThanOrEqual(2000);
      expect(result.qrReady).toBe(true);
    }
  });
});

it("measures complete share URL budgets across representative examples", async () => {
  const { shareFixtures } = await import("./helpers/share-fixtures.ts");
  const fixtures = shareFixtures();
  for (const [name, state] of Object.entries(fixtures)) {
    const encoded = await encodeShare(state, BASE_URL);
    if (
      ["empty", "highlight", "ten-highlights", "comment", "arrow"].includes(
        name
      )
    ) {
      expect(encoded.bytes, name).toBeLessThanOrEqual(2000);
      expect(encoded.qrReady, name).toBe(true);
    }
    if (name === "over-limit") {
      expect(encoded.url, name).toBeUndefined();
    }
    if (encoded.url) {
      expect((await decodeShare(encoded.url)).document, name).toEqual(state);
    }
  }
});
