// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createAnchors } from "../../../components/annotations/anchors.ts";

function setRect(
  element: Element,
  left: number,
  top: number,
  width: number,
  height: number
) {
  element.getBoundingClientRect = () => ({
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => ({}),
    top,
    width,
    x: left,
    y: top,
  });
}

function fixture() {
  const article = document.createElement("article");
  const heading = document.createElement("h2");
  heading.id = "composition";
  heading.textContent = "Composition";
  const paragraph = document.createElement("p");
  paragraph.textContent = "Independent steps can run together.";
  const host = document.createElement("div");
  article.append(heading, paragraph, host);
  document.body.append(article);
  setRect(article, 100, 100, 600, 1000);
  setRect(host, 100, 100, 600, 1000);
  setRect(heading, 100, 120, 600, 30);
  setRect(paragraph, 100, 200, 600, 100);
  return { article, heading, host, paragraph };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("documentation element anchors", () => {
  it("keeps a mark relative to its block after responsive reflow", () => {
    const { article, host, paragraph } = fixture();
    const anchors = createAnchors(article, host);
    const anchor = anchors.anchorAt(300, 150);
    expect(anchor.x).toBe(0.5);
    expect(anchor.y).toBe(0.5);
    setRect(host, 20, 100, 300, 1800);
    setRect(paragraph, 20, 500, 300, 200);
    expect(anchors.resolveAnchor(anchor)).toEqual({ x: 150, y: 500 });
    anchors.dispose();
  });

  it("preserves identities when unrelated content is inserted before a block", () => {
    const { article, host, paragraph } = fixture();
    const original = createAnchors(article, host);
    const anchor = original.anchorAt(300, 150);
    original.dispose();
    const inserted = document.createElement("p");
    inserted.textContent = "New introduction.";
    paragraph.before(inserted);
    setRect(inserted, 100, 155, 600, 30);
    const remounted = createAnchors(article, host);
    expect(remounted.resolveAnchor(anchor)).toEqual({ x: 300, y: 150 });
    expect(paragraph.getAttribute("data-annotation-anchor")).toBe(anchor.id);
    remounted.dispose();
  });

  it("does not attach an orphan to another block after its content changes", () => {
    const { article, host, paragraph } = fixture();
    const original = createAnchors(article, host);
    const anchor = original.anchorAt(300, 150);
    original.dispose();
    paragraph.textContent = "A different paragraph.";
    const remounted = createAnchors(article, host);
    expect(remounted.resolveAnchor(anchor)).toBeNull();
    remounted.dispose();
  });

  it("preserves marks placed in the margin outside the target box", () => {
    const { article, host } = fixture();
    const anchors = createAnchors(article, host);
    const anchor = anchors.anchorAt(620, 150);
    expect(anchor.x).toBeGreaterThan(1);
    expect(anchors.resolveAnchor(anchor)?.x).toBeCloseTo(620);
    expect(anchors.resolveAnchor(anchor)?.y).toBeCloseTo(150);
    anchors.dispose();
  });

  it("prefers a nested paragraph over the larger containing list item", () => {
    const { article, host, paragraph } = fixture();
    const list = document.createElement("ul");
    const item = document.createElement("li");
    paragraph.replaceWith(list);
    item.append(paragraph);
    list.append(item);
    setRect(item, 90, 190, 620, 140);
    const anchors = createAnchors(article, host);
    const anchor = anchors.anchorAt(300, 150);
    expect(anchor.id).toBe(paragraph.getAttribute("data-annotation-anchor"));
    anchors.dispose();
  });
});
