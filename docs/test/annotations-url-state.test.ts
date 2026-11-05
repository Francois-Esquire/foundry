import { describe, expect, it, vi } from "vitest";
import type { AnnotationDocument, ShareResult } from "../annotations/model.ts";
import { createUrlState } from "../annotations/url-state.ts";

const document: AnnotationDocument = { marks: [], version: 1 };
const result = (notes: string): ShareResult => ({
  bytes: 40,
  message: "Ready",
  qrReady: true,
  url: `https://docs.test/page?notes=${notes}`,
});

function harness() {
  let href = "https://docs.test/page?theme=dark#section";
  const pending: ((value: ShareResult) => void)[] = [];
  const onResult = vi.fn();
  const state = createUrlState({
    encode: () => new Promise((resolve) => pending.push(resolve)),
    onResult,
    readUrl: () => href,
    replace: (value) => {
      href = value;
    },
  });
  return {
    navigate: (value: string) => {
      href = value;
    },
    onResult,
    pending,
    state,
    url: () => href,
  };
}

describe("annotation URL lifecycle", () => {
  it("ignores stale encodes and preserves unrelated query and fragment", async () => {
    const h = harness();
    const first = h.state.update(document);
    const second = h.state.update(document);
    h.pending[1]?.(result("new"));
    await second;
    h.pending[0]?.(result("old"));
    expect(await first).toBeNull();
    expect(h.url()).toBe("https://docs.test/page?theme=dark&notes=new#section");
    expect(h.onResult).toHaveBeenCalledTimes(1);
  });
  it("does not update a new page or a disposed editor", async () => {
    const h = harness();
    const work = h.state.update(document);
    h.navigate("https://docs.test/other");
    h.pending[0]?.(result("old"));
    expect(await work).toBeNull();
    const next = h.state.update(document);
    h.state.dispose();
    h.pending[1]?.(result("old"));
    expect(await next).toBeNull();
    expect(h.onResult).not.toHaveBeenCalled();
  });
  it("removes stale URL annotations when current state exceeds the link limit", async () => {
    const h = harness();
    h.navigate("https://docs.test/page?theme=dark&notes=old#section");
    const work = h.state.update(document);
    h.pending[0]?.({ bytes: 9000, message: "Too large", qrReady: false });
    await work;
    expect(h.url()).toBe("https://docs.test/page?theme=dark#section");
  });
  it("preserves fragment changes during encoding", async () => {
    const h = harness();
    const work = h.state.update(document);
    h.navigate("https://docs.test/page?theme=light#new-section");
    h.pending[0]?.(result("mark"));
    await work;
    expect(h.url()).toContain("theme=light&notes=mark#new-section");
  });
});
