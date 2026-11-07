// @vitest-environment happy-dom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AnnotationDocument } from "../../../lib/annotations/model.ts";
import { decodeShare, encodeShare } from "../../../lib/annotations/share.ts";
import { installMemoryStorage } from "./helpers/memory-storage.ts";

const PAGE = "/guide/";
const LOCAL = "foundry:annotations:v1:/guide";
const PREVIOUS = "foundry:annotations-previous:v1:/guide";
const ARTICLE =
  '<div id="blume-content"><article><h2 id="one">One</h2><p>Install Bun before running the tests.</p><h2 id="two">Two</h2><p>Second section.</p></article></div><p data-annotation-storage></p>';

/** Happy DOM has no layout, so block-attached notes list as unresolved. */
const LIST_PREFIX = /^(Unresolved · )?text: /;

let storage: ReturnType<typeof installMemoryStorage>;
let historyIndex = 0;

async function settle(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  for (let step = 0; step < 20; step += 1) {
    await Promise.resolve();
  }
}

function currentHost() {
  return document.querySelector<HTMLElement>("[data-annotation-host]");
}

/** Remounting waits for an async share decode, so poll for a new host element. */
async function mounted(previous: HTMLElement | null) {
  await settle();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const next = currentHost();
    if (next && next !== previous) {
      return;
    }
    await settle(10);
  }
  throw new Error("Annotations did not remount");
}

/** Debounce plus native gzip encoding. */
const urlWritten = () => settle(260);

function host() {
  const found = document.querySelector<HTMLElement>("[data-annotation-host]");
  if (!found) {
    throw new Error("Annotation host is not mounted");
  }
  return found;
}

function button(name: string, root: ParentNode = host()) {
  const found = root.querySelector<HTMLButtonElement>(
    `button[aria-label="${name}"]`
  );
  if (!found) {
    throw new Error(`Missing button ${name}`);
  }
  return found;
}

function addNote(text: string) {
  button("Add text").click();
  host()
    .querySelector(".annotation-surface")
    ?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
    );
  const input = host().querySelector<HTMLTextAreaElement>("textarea");
  if (!input?.form) {
    throw new Error("Missing note form");
  }
  input.value = text;
  input.form.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true })
  );
}

function openMenu() {
  host().querySelector<HTMLButtonElement>("button[data-unresolved]")?.click();
}

/** The notes the editor currently holds, read from its annotation menu. */
function shown() {
  openMenu();
  const rows = [...host().querySelectorAll(".annotation-list-row > p")].map(
    (row) => row.textContent?.replace(LIST_PREFIX, "")
  );
  host().querySelector<HTMLButtonElement>(".annotation-panel-close")?.click();
  return rows;
}

function texts(source: string | undefined) {
  return source === undefined
    ? undefined
    : (JSON.parse(source) as AnnotationDocument).marks.map((mark) => mark.text);
}

async function urlTexts() {
  const shared = await decodeShare(location.href);
  return shared.document?.marks.map((mark) => mark.text);
}

function note(id: string, text: string): AnnotationDocument["marks"][number] {
  return {
    anchor: { id: "article", x: 0.5, y: 0.2 },
    color: "#c93848",
    id,
    kind: "text",
    points: [{ x: 0, y: 0 }],
    text,
  };
}

/** Astro pushes a same-page fragment entry from the current URL, then dispatches popstate. */
async function followHeading(hash: string) {
  const previous = currentHost();
  const url = new URL(location.href);
  url.hash = hash;
  historyIndex += 1;
  history.pushState(
    { index: historyIndex, scrollX: 0, scrollY: 0 },
    "",
    url.href
  );
  window.dispatchEvent(new PopStateEvent("popstate"));
  await mounted(previous);
}

async function back() {
  const previous = currentHost();
  history.back();
  await mounted(previous);
}

/**
 * Happy DOM discards forward entries after replaceState, so Forward is
 * emulated: the traversed entry's URL becomes current, then popstate fires.
 */
async function revisit(url: string) {
  const previous = currentHost();
  history.replaceState(history.state, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await mounted(previous);
}

async function load(url: string) {
  document.dispatchEvent(new Event("astro:before-swap"));
  historyIndex += 1;
  history.pushState({ index: historyIndex, scrollX: 0, scrollY: 0 }, "", url);
  document.body.innerHTML = ARTICLE;
  document.dispatchEvent(new Event("astro:page-load"));
  await mounted(null);
}

beforeAll(async () => {
  storage = installMemoryStorage();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* Geometry is irrelevant to persistence. */
      }
      disconnect() {
        /* Nothing to release. */
      }
    }
  );
  await import("../../../components/annotations/mount.ts");
});

beforeEach(() => {
  storage.data.clear();
  storage.failWrites();
});

afterEach(() => {
  document.dispatchEvent(new Event("astro:before-swap"));
  document.body.replaceChildren();
});

describe("annotation mount lifecycle", () => {
  it("keeps the newest notes across same-page fragment Back and Forward", async () => {
    await load(`${PAGE}?view=read#one`);
    addNote("v1");
    await urlWritten();
    expect(await urlTexts()).toEqual(["v1"]);
    await followHeading("two");
    addNote("v2");
    await urlWritten();
    expect(location.href).toContain("view=read");
    expect(location.hash).toBe("#two");
    const forwardEntry = location.href;
    await back();
    expect(location.hash).toBe("#one");
    expect(shown()).toEqual(["v1", "v2"]);
    expect(history.state).toMatchObject({ scrollX: 0, scrollY: 0 });
    await urlWritten();
    expect(await urlTexts()).toEqual(["v1", "v2"]);
    addNote("v3");
    await urlWritten();
    expect(texts(storage.data.get(LOCAL))).toEqual(["v1", "v2", "v3"]);
    await revisit(forwardEntry);
    expect(location.hash).toBe("#two");
    expect(shown()).toEqual(["v1", "v2", "v3"]);
    await urlWritten();
    expect(await urlTexts()).toEqual(["v1", "v2", "v3"]);
  });

  it("keeps an edit made just before following a heading", async () => {
    await load(`${PAGE}#one`);
    addNote("v1");
    await urlWritten();
    addNote("v2");
    await followHeading("two");
    expect(shown()).toEqual(["v1", "v2"]);
    await urlWritten();
    expect(location.hash).toBe("#two");
    expect(await urlTexts()).toEqual(["v1", "v2"]);
    expect(texts(storage.data.get(LOCAL))).toEqual(["v1", "v2"]);
  });

  it("shows the local copy when reloading its own link", async () => {
    await load(PAGE);
    addNote("mine");
    await urlWritten();
    const own = location.href;
    addNote("newer");
    await load(own);
    expect(shown()).toEqual(["mine", "newer"]);
  });

  it("recognizes an unrecorded link that initially matches local notes as its own history", async () => {
    const initial: AnnotationDocument = {
      marks: [note("a", "mine")],
      version: 1,
    };
    storage.data.set(LOCAL, JSON.stringify(initial));
    const shared = await encodeShare(initial, `https://docs.test${PAGE}#one`);
    if (!shared.url) {
      throw new Error("Shared link missing");
    }
    await load(shared.url.replace("https://docs.test", ""));
    await followHeading("two");
    addNote("newer");
    await urlWritten();
    await back();
    expect(shown()).toEqual(["mine", "newer"]);
    expect(texts(storage.data.get(LOCAL))).toEqual(["mine", "newer"]);
  });

  it("opens a shared snapshot without replacing local notes until it is edited", async () => {
    storage.data.set(
      LOCAL,
      JSON.stringify({ marks: [note("a", "mine")], version: 1 })
    );
    const shared = await encodeShare(
      { marks: [note("b", "shared")], version: 1 },
      `https://docs.test${PAGE}#two`
    );
    if (!shared.url) {
      throw new Error("Shared link missing");
    }
    const sharedPath = shared.url.replace("https://docs.test", "");
    await load(sharedPath);
    expect(shown()).toEqual(["shared"]);
    expect(texts(storage.data.get(LOCAL))).toEqual(["mine"]);
    expect(
      document.querySelector("[data-annotation-storage]")?.textContent
    ).toContain("earlier notes");
    await load(sharedPath);
    expect(shown()).toEqual(["shared"]);
    addNote("reply");
    expect(texts(storage.data.get(LOCAL))).toEqual(["shared", "reply"]);
    expect(texts(storage.data.get(PREVIOUS))).toEqual(["mine"]);
    await urlWritten();
    // Back to the shared entry is now this browser's history, not a new import.
    await back();
    expect(`${location.pathname}${location.search}${location.hash}`).toBe(
      sharedPath
    );
    expect(shown()).toEqual(["shared", "reply"]);
    addNote("again");
    expect(texts(storage.data.get(PREVIOUS))).toEqual(["mine"]);
    openMenu();
    const restoring = currentHost();
    button("Restore previous notes").click();
    await mounted(restoring);
    expect(shown()).toEqual(["mine"]);
    expect(texts(storage.data.get(LOCAL))).toEqual(["mine"]);
    expect(texts(storage.data.get(PREVIOUS))).toEqual([
      "shared",
      "reply",
      "again",
    ]);
    expect(new URL(location.href).searchParams.has("notes")).toBe(false);
  });

  it("does not overwrite local notes when their previous copy cannot be kept", async () => {
    storage.data.set(
      LOCAL,
      JSON.stringify({ marks: [note("a", "mine")], version: 1 })
    );
    const shared = await encodeShare(
      { marks: [note("b", "shared")], version: 1 },
      `https://docs.test${PAGE}`
    );
    storage.failWrites((key) => key === PREVIOUS);
    await load(shared.url?.replace("https://docs.test", "") ?? PAGE);
    addNote("reply");
    expect(texts(storage.data.get(LOCAL))).toEqual(["mine"]);
    expect(
      document.querySelector("[data-annotation-storage]")?.textContent
    ).toContain("not saved in this browser");
    await urlWritten();
    expect(await urlTexts()).toEqual(["shared", "reply"]);
  });

  it("preserves local notes for malformed links and keeps page state separate across swaps", async () => {
    storage.data.set(
      LOCAL,
      JSON.stringify({ marks: [note("a", "mine")], version: 1 })
    );
    await load(`${PAGE}?notes=1g.not-gzip`);
    expect(shown()).toEqual(["mine"]);
    expect(
      document.querySelector("[data-annotation-storage]")?.textContent
    ).toContain("could not be read");
    addNote("pending");
    await load("/other/");
    await urlWritten();
    expect(location.pathname).toBe("/other/");
    expect(location.search).toBe("");
    expect(shown()).toEqual([]);
    expect(texts(storage.data.get(LOCAL))).toEqual(["mine", "pending"]);
  });

  it("does not copy a stale link when the notes change or the page changes during Share", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await load(PAGE);
    addNote("v1");
    button("Share annotations").click();
    addNote("v2");
    await urlWritten();
    expect(host().querySelector(".annotation-feedback")?.textContent).toContain(
      "changed while the link was being created"
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(await urlTexts()).toEqual(["v1", "v2"]);
    button("Share annotations").click();
    await urlWritten();
    expect(writeText).toHaveBeenCalledWith(location.href);
    expect(host().querySelector(".annotation-feedback")?.textContent).toContain(
      "Link copied"
    );
    writeText.mockClear();
    button("Share annotations").click();
    await load("/other/");
    await urlWritten();
    expect(writeText).not.toHaveBeenCalled();
    expect(location.href).toBe(`${location.origin}/other/`);
  });
});
