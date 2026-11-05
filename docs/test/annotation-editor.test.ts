// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountEditor } from "../annotations/editor.ts";
import type {
  AnnotationDocument,
  Mark,
  TextRect,
  TextTarget,
} from "../annotations/model.ts";

const target: TextTarget = {
  segments: [
    {
      blockId: "paragraph",
      end: 5,
      prefix: "",
      quote: "hello",
      start: 0,
      suffix: " world",
    },
  ],
};
const mark: Mark = {
  anchor: { id: "paragraph", x: 0, y: 0 },
  color: "#c93848",
  id: "one",
  kind: "highlight",
  points: [],
  target,
  text: "",
};
let resize: (() => void) | undefined;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {
        /* Geometry updates are triggered explicitly by the test. */
      }
      disconnect() {
        resize = undefined;
      }
    }
  );
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(initial: AnnotationDocument = { marks: [], version: 1 }) {
  const article = document.createElement("article");
  const host = document.createElement("div");
  article.append(host);
  document.body.append(article);
  Object.defineProperties(host, {
    clientHeight: { value: 1000 },
    clientWidth: { value: 600 },
  });
  let selection: TextTarget | null = null;
  let rects: TextRect[] | null = [{ height: 20, width: 120, x: 20, y: 80 }];
  const change = vi.fn();
  const share = vi.fn().mockResolvedValue({
    bytes: 480,
    message: "Link copied. 480 bytes.",
    qrReady: true,
  });
  cleanup = mountEditor(host, {
    anchorAt: (x, y) => ({ id: "paragraph", x, y }),
    initial,
    onChange: change,
    onShare: share,
    resolveAnchor: (anchor) => ({ x: anchor.x, y: anchor.y }),
    textAnchors: {
      captureSelection: () => selection,
      dispose: vi.fn(),
      resolveTarget: () => rects,
      targetAtPoint: () => selection,
      targetForStroke: () => null,
    },
  });
  function button(name: string, root: ParentNode = host) {
    const found = root.querySelector<HTMLButtonElement>(
      `button[aria-label="${name}"]`
    );
    if (!found) {
      throw new Error(`Missing button ${name}`);
    }
    return found;
  }
  return {
    button,
    change,
    host,
    select: () => {
      selection = target;
    },
    setRects: (next: TextRect[] | null) => {
      rects = next;
      resize?.();
    },
    share,
  };
}

describe("annotation editor", () => {
  it("hides and restores marks without modifying serialized state or URL", () => {
    const f = fixture({ marks: [mark], version: 1 });
    const before = location.href;
    expect(f.host.querySelectorAll(".annotation-highlight")).toHaveLength(1);
    f.button("Hide annotations").click();
    expect(f.host.dataset.annotationsHidden).toBe("true");
    expect(f.button("Show annotations").getAttribute("aria-pressed")).toBe(
      "true"
    );
    f.button("Show annotations").click();
    expect(f.host.dataset.annotationsHidden).toBe("false");
    expect(f.change).not.toHaveBeenCalled();
    expect(location.href).toBe(before);
  });

  it("creates a serializable selected-text highlight through the secondary menu", () => {
    const f = fixture();
    f.select();
    f.button("Annotation menu").click();
    const panel = f.host.querySelector(".annotation-panel");
    expect(panel).not.toBeNull();
    const event = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    f.button("Highlight", panel ?? f.host).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    f.button("Highlight", panel ?? f.host).click();
    expect(f.change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        marks: [expect.objectContaining({ kind: "highlight", target })],
      })
    );
    expect(f.host.querySelectorAll(".annotation-highlight")).toHaveLength(1);
  });

  it("rebuilds highlights for wrapped lines and surfaces unresolved targets", () => {
    const f = fixture({ marks: [mark], version: 1 });
    f.setRects([
      { height: 20, width: 80, x: 20, y: 80 },
      { height: 20, width: 40, x: 20, y: 105 },
    ]);
    expect(f.host.querySelectorAll(".annotation-highlight")).toHaveLength(2);
    f.setRects(null);
    expect(f.host.querySelectorAll(".annotation-highlight")).toHaveLength(0);
    const menu = f.host.querySelector<HTMLButtonElement>(
      "button[data-unresolved]"
    );
    expect(menu?.getAttribute("aria-label")).toBe(
      "Annotation menu, 1 unresolved"
    );
    menu?.click();
    expect(f.host.querySelector(".annotation-panel")?.textContent).toContain(
      "Unresolved"
    );
  });

  it("saves and edits attached comments without duplicating their identity", () => {
    const f = fixture();
    f.select();
    f.button("Annotation menu").click();
    f.button(
      "Comment",
      f.host.querySelector(".annotation-panel") ?? f.host
    ).click();
    const input = f.host.querySelector<HTMLTextAreaElement>("textarea");
    if (!input) {
      throw new Error("Missing note editor");
    }
    input.value = "This matters";
    input.form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    const saved = f.change.mock.lastCall?.[0].marks[0] as Mark;
    expect(saved).toMatchObject({
      kind: "comment",
      target,
      text: "This matters",
    });
    f.host
      .querySelector<SVGGElement>(".annotation-comment-marker")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const edit = f.host.querySelector<HTMLTextAreaElement>("textarea");
    if (!edit) {
      throw new Error("Missing edit form");
    }
    edit.value = "Updated";
    edit.form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    expect(f.change.mock.lastCall?.[0].marks).toEqual([
      expect.objectContaining({ id: saved.id, text: "Updated" }),
    ]);
  });

  it("does not intercept Escape from unrelated document controls", () => {
    const f = fixture();
    f.button("Draw").click();
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    outside.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    expect(document.activeElement).toBe(outside);
    expect(f.host.dataset.annotationTool).toBe("draw");
    f.button("Draw").dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    expect(f.host.dataset.annotationTool).toBe("browse");
    expect(document.activeElement).toBe(f.button("Browse"));
  });

  it("retains an unsaved comment draft when the page reaches its mark limit", () => {
    const marks = Array.from({ length: 300 }, (_, index) => ({
      ...mark,
      id: `mark-${index}`,
    }));
    const f = fixture({ marks, version: 1 });
    f.select();
    f.button("Annotation menu").click();
    f.button(
      "Comment",
      f.host.querySelector(".annotation-panel") ?? f.host
    ).click();
    const input = f.host.querySelector<HTMLTextAreaElement>("textarea");
    if (!input) {
      throw new Error("Missing draft");
    }
    input.value = "Do not lose this note";
    input.form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    expect(f.change).not.toHaveBeenCalled();
    expect(f.host.querySelector("textarea")?.value).toBe(
      "Do not lose this note"
    );
    expect(f.host.querySelector(".annotation-feedback")?.textContent).toContain(
      "300 annotations"
    );
  });

  it("shares the current document and cleans up pending selection work on disposal", async () => {
    const f = fixture({ marks: [mark], version: 1 });
    f.button("Share annotations").click();
    await Promise.resolve();
    expect(f.share).toHaveBeenCalledWith({ marks: [mark], version: 1 });
    document.dispatchEvent(new Event("selectionchange"));
    cleanup?.();
    cleanup = undefined;
    expect(f.host.querySelector(".annotation-toolbar")).toBeNull();
    expect(f.host.querySelector(".annotation-surface")).toBeNull();
  });
});
