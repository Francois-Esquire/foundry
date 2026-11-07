// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnchors } from "../../../components/annotations/anchors.ts";
import { createTextAnchors } from "../../../components/annotations/text-anchors.ts";

function rect(x: number, y: number, width: number, height: number) {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    toJSON: () => ({}),
    top: y,
    width,
    x,
    y,
  };
}

function fixture(
  content = "<p>The <strong>same words</strong> can wrap across lines.</p><p>Second paragraph has another target.</p>"
) {
  const article = document.createElement("article");
  article.innerHTML = content;
  const host = document.createElement("div");
  host.className = "annotation-host";
  article.append(host);
  document.body.append(article);
  host.getBoundingClientRect = () => rect(20, 50, 600, 1000);
  for (const element of article.querySelectorAll<HTMLElement>("p,h2,li")) {
    element.getBoundingClientRect = () => rect(20, 100, 600, 100);
  }
  const blocks = createAnchors(article, host);
  const anchors = createTextAnchors(article, host);
  return { anchors, article, blocks, host };
}

function select(start: Node, from: number, end: Node, to: number) {
  const selection = document.getSelection();
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("text-attached annotations", () => {
  it("captures exact offsets across inline formatting without wrapping prose", () => {
    const { anchors, article } = fixture();
    const first = article.querySelector("p")?.firstChild;
    const last = article.querySelector("strong")?.firstChild;
    if (!(first && last)) {
      throw new Error("fixture missing");
    }
    select(first, 0, last, 10);
    const target = anchors.captureSelection();
    expect(target?.segments).toHaveLength(1);
    expect(target?.segments[0]).toMatchObject({
      end: 14,
      prefix: "",
      quote: "The same words",
      start: 0,
      suffix: " can wrap across lines.",
    });
    expect(article.querySelectorAll("span")).toHaveLength(0);
  });

  it("captures selections spanning paragraphs as separate targets", () => {
    const { anchors, article } = fixture();
    const start = article.querySelector("strong")?.firstChild;
    const end = article.querySelectorAll("p")[1]?.firstChild;
    if (!(start && end)) {
      throw new Error("fixture missing");
    }
    select(start, 5, end, 16);
    expect(
      anchors.captureSelection()?.segments.map((segment) => segment.quote)
    ).toEqual(["words can wrap across lines.", "Second paragraph"]);
  });

  it("rejects selections outside the article, collapsed selections, and annotation text", () => {
    const { anchors, host, article } = fixture();
    expect(anchors.captureSelection()).toBeNull();
    const outside = document.createTextNode("Elsewhere");
    document.body.append(outside);
    const inside = article.querySelector("p")?.firstChild;
    if (!inside) {
      throw new Error("fixture missing");
    }
    select(outside, 0, outside, 4);
    expect(anchors.captureSelection()).toBeNull();
    host.textContent = "Annotation contents";
    if (!host.firstChild) {
      throw new Error("fixture missing");
    }
    select(host.firstChild, 0, host.firstChild, 10);
    expect(anchors.captureSelection()).toBeNull();
  });

  it("recomputes line rectangles after layout changes", () => {
    const { anchors, article } = fixture();
    const node = article.querySelector("strong")?.firstChild;
    if (!node) {
      throw new Error("fixture missing");
    }
    select(node, 0, node, 10);
    const target = anchors.captureSelection();
    if (!target) {
      throw new Error("target missing");
    }
    let boxes = [rect(60, 100, 100, 20)];
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(
      () => boxes as unknown as DOMRectList
    );
    expect(anchors.resolveTarget(target)).toEqual([
      { height: 20, width: 100, x: 40, y: 50 },
    ]);
    boxes = [rect(20, 120, 40, 20), rect(20, 140, 60, 20)];
    expect(anchors.resolveTarget(target)).toEqual([
      { height: 20, width: 40, x: 0, y: 70 },
      { height: 20, width: 60, x: 0, y: 90 },
    ]);
  });

  it("merges overlapping inline fragment rectangles into one highlight per line", () => {
    const { anchors, article } = fixture();
    const node = article.querySelector("strong")?.firstChild;
    if (!node) {
      throw new Error("fixture missing");
    }
    select(node, 0, node, 10);
    const target = anchors.captureSelection();
    if (!target) {
      throw new Error("target missing");
    }
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      rect(20, 100, 100, 20),
      rect(40, 101, 80, 19),
      rect(20, 125, 60, 20),
    ] as unknown as DOMRectList);
    expect(anchors.resolveTarget(target)).toEqual([
      { height: 20, width: 100, x: 0, y: 50 },
      { height: 20, width: 60, x: 0, y: 75 },
    ]);
  });

  it("finds a unique quote after content shifts and refuses missing or ambiguous matches", () => {
    const { anchors, article } = fixture("<p>Before unique phrase after.</p>");
    const node = article.querySelector("p")?.firstChild;
    if (!node) {
      throw new Error("fixture missing");
    }
    select(node, 7, node, 20);
    const target = anchors.captureSelection();
    if (!target) {
      throw new Error("target missing");
    }
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      rect(20, 100, 130, 20),
    ] as unknown as DOMRectList);
    node.textContent = "New introduction. Before unique phrase after.";
    expect(anchors.resolveTarget(target)).not.toBeNull();
    node.textContent = "unique phrase. unique phrase.";
    expect(anchors.resolveTarget(target)).toBeNull();
    node.textContent = "This text has changed entirely.";
    expect(anchors.resolveTarget(target)).toBeNull();
  });

  it("uses context to distinguish repeated phrases after positions shift", () => {
    const { anchors, article } = fixture(
      "<p>First same words here. Second same words there.</p>"
    );
    const node = article.querySelector("p")?.firstChild;
    if (!node) {
      throw new Error("fixture missing");
    }
    select(node, 30, node, 40);
    const target = anchors.captureSelection();
    if (!target) {
      throw new Error("target missing");
    }
    expect(target.segments[0]?.quote).toBe("same words");
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
      this: Range
    ) {
      return [rect(this.startOffset, 100, 10, 20)] as unknown as DOMRectList;
    });
    node.textContent = "Intro First same words here. Second same words there.";
    expect(anchors.resolveTarget(target)?.[0]?.x).toBe(16);
  });

  it("leaves a moved quote unresolved when its context is gone", () => {
    const { anchors, article, host } = fixture(
      "<p>Install Bun before running the tests.</p><p>Other text.</p>"
    );
    const node = article.querySelector("p")?.firstChild;
    if (!node) {
      throw new Error("fixture missing");
    }
    select(node, 8, node, 11);
    const target = anchors.captureSelection();
    if (!target) {
      throw new Error("target missing");
    }
    expect(target.segments[0]?.quote).toBe("Bun");
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      rect(20, 100, 30, 20),
    ] as unknown as DOMRectList);
    const [first, second] = article.querySelectorAll("p");
    if (!(first && second)) {
      throw new Error("fixture missing");
    }
    first.textContent = "Install the toolchain before running the tests.";
    second.textContent = "Bun users can skip this step.";
    // A rebuilt page assigns new content-hash block identities.
    createAnchors(article, host);
    expect(anchors.resolveTarget(target)).toBeNull();
  });

  it("does not treat a whole-block quote as context for a mid-sentence match", () => {
    const { anchors, article, host } = fixture(
      "<h2>Installation</h2><p>Read the guide.</p>"
    );
    const heading = article.querySelector("h2")?.firstChild;
    if (!heading) {
      throw new Error("fixture missing");
    }
    select(heading, 0, heading, 12);
    const target = anchors.captureSelection();
    if (!target) {
      throw new Error("target missing");
    }
    expect(target.segments[0]).toMatchObject({ prefix: "", suffix: "" });
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      rect(20, 100, 90, 20),
    ] as unknown as DOMRectList);
    article.innerHTML =
      "<h2>Setup</h2><p>Installation takes a minute.</p><h2>Installation</h2>";
    createAnchors(article, host);
    expect(anchors.resolveTarget(target)).not.toBeNull();
    article.querySelectorAll("h2")[1]?.remove();
    createAnchors(article, host);
    expect(anchors.resolveTarget(target)).toBeNull();
  });

  it("recovers a quote in a changed block when its surrounding words survive", () => {
    const { anchors, article, host } = fixture(
      "<p>Run the install step before running the tests in CI.</p><p>Other.</p>"
    );
    const node = article.querySelector("p")?.firstChild;
    if (!node) {
      throw new Error("fixture missing");
    }
    select(node, 8, node, 20);
    const target = anchors.captureSelection();
    if (!target) {
      throw new Error("target missing");
    }
    expect(target.segments[0]?.quote).toBe("install step");
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
      this: Range
    ) {
      return [rect(this.startOffset, 100, 10, 20)] as unknown as DOMRectList;
    });
    const [first, second] = article.querySelectorAll("p");
    if (!(first && second)) {
      throw new Error("fixture missing");
    }
    first.textContent = "Other.";
    second.textContent =
      "Moved here: Run the install step before running the tests in CI.";
    createAnchors(article, host);
    // Offset 20 in the second paragraph, relative to the host's left edge at 20.
    expect(anchors.resolveTarget(target)?.[0]?.x).toBe(0);
  });

  it("captures element-boundary selections and preserves raw Unicode offsets", () => {
    const { anchors, article } = fixture(
      '<p>😀 <strong>same <a href="#">words</a></strong> after.</p>'
    );
    const strong = article.querySelector("strong");
    if (!strong) {
      throw new Error("fixture missing");
    }
    select(strong, 0, strong, strong.childNodes.length);
    expect(anchors.captureSelection()?.segments[0]).toMatchObject({
      end: 13,
      prefix: "😀 ",
      quote: "same words",
      start: 3,
      suffix: " after.",
    });
  });

  it("proposes only nearby words for arrow and horizontal underline gestures", () => {
    const { anchors } = fixture("<p>First words here.</p>");
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
      this: Range
    ) {
      return [
        rect(
          20 + this.startOffset * 8,
          100,
          (this.endOffset - this.startOffset) * 8,
          20
        ),
      ] as unknown as DOMRectList;
    });
    expect(anchors.targetAtPoint({ x: 60, y: 55 })?.segments[0]?.quote).toBe(
      "words"
    );
    expect(
      anchors.targetForStroke([
        { x: 48, y: 72 },
        { x: 88, y: 73 },
      ])?.segments[0]?.quote
    ).toBe("words");
    expect(anchors.targetAtPoint({ x: 44, y: 55 })).toBeNull();
  });

  it("does not infer attachments from distant or non-horizontal gestures", () => {
    const { anchors } = fixture();
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
      rect(20, 100, 30, 20),
    ] as unknown as DOMRectList);
    expect(anchors.targetAtPoint({ x: 1000, y: 1000 })).toBeNull();
    expect(
      anchors.targetForStroke([
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ])
    ).toBeNull();
  });

  it("rejects oversized selections and releases its index after disposal", () => {
    const { anchors, article } = fixture(`<p>${"a".repeat(8001)}</p>`);
    const node = article.querySelector("p")?.firstChild;
    if (!node) {
      throw new Error("fixture missing");
    }
    select(node, 0, node, 8001);
    expect(anchors.captureSelection()).toBeNull();
    anchors.dispose();
    select(node, 0, node, 2);
    expect(anchors.captureSelection()).toBeNull();
  });
});
