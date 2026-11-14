import type { Content } from "@foundry/artifacts";
import { describe, expect, it } from "vitest";
import {
  chooseEntry,
  type EditorRegistration,
  resolveEditors,
} from "~/main/artifacts/resolver";

function editor(
  moduleName: string,
  mimeTypes: string[],
  mode: "read" | "write" = "write"
): EditorRegistration {
  return {
    mimeTypes,
    mode,
    moduleId: moduleName.toLowerCase(),
    moduleName,
    release: `${moduleName.toLowerCase()}-release`,
    view: "edit",
    viewTitle: `${moduleName} editor`,
  };
}

const notes = editor("Notes", ["application/vnd.example.notes"]);
const markdown = editor("Markdown", ["text/markdown"]);
const plain = editor("Plain", ["text/plain"], "read");
const json = editor("Json", ["application/json"]);
const images = editor("Images", ["image/png"]);
const pages = editor("Pages", ["text/html"]);
const ALL = [notes, markdown, plain, json, images, pages];

function names(resolution: ReturnType<typeof resolveEditors>) {
  return resolution.candidates.map((found) => found.moduleName);
}

describe("editor precedence", () => {
  it.each([
    {
      entryMime: "text/markdown",
      expected: ["Notes"],
      match: "type",
      mime: "application/vnd.example.notes",
      name: "an exact Artifact type beats the entry MIME and its family",
      type: "application/vnd.example.notes",
    },
    {
      entryMime: "text/markdown",
      expected: ["Markdown"],
      match: "entry",
      mime: "text/markdown",
      name: "the entry MIME applies when no editor declares the type",
      type: "application/vnd.example.other",
    },
    {
      entryMime: null,
      expected: ["Markdown"],
      match: "type",
      mime: "text/markdown",
      name: "type parameters and case are ignored",
      type: "Text/Markdown; charset=utf-8",
    },
    {
      entryMime: "text/markdown; charset=utf-8",
      expected: ["Markdown"],
      match: "entry",
      mime: "text/markdown",
      name: "entry MIME parameters are ignored",
      type: "application/vnd.example.other",
    },
    {
      entryMime: "text/x-log",
      expected: ["Markdown", "Plain"],
      match: "family",
      mime: "text/x-log",
      name: "the type's registry family applies after exact matches",
      type: "text/x-log",
    },
    {
      entryMime: "text/x-log",
      expected: ["Markdown", "Plain"],
      match: "family",
      mime: "text/x-log",
      name: "an unrecognized type takes its entry file's family",
      type: "application/vnd.example.other",
    },
    {
      entryMime: null,
      expected: ["Json"],
      match: "family",
      mime: "application/ld+json",
      name: "structured data is its own family",
      type: "application/ld+json",
    },
    {
      entryMime: null,
      expected: ["Pages"],
      match: "family",
      mime: "application/xhtml+html",
      name: "HTML is its own family, not text",
      type: "application/xhtml+html",
    },
    {
      entryMime: "application/pdf",
      expected: [],
      match: "none",
      mime: "application/pdf",
      name: "an unknown type without a matching entry has no editor",
      type: "application/pdf",
    },
    {
      entryMime: "video/mp4",
      expected: [],
      match: "none",
      mime: "video/mp4",
      name: "a recognized family nobody edits has no editor",
      type: "video/mp4",
    },
  ])("$name", ({ entryMime, expected, match, mime, type }) => {
    const resolution = resolveEditors({ editors: ALL, entryMime, type });
    expect(names(resolution)).toEqual(expected);
    expect(resolution.match).toBe(match);
    expect(resolution.mime).toBe(mime);
  });

  it("keeps each candidate's View, title and read or write mode", () => {
    const resolution = resolveEditors({
      editors: ALL,
      entryMime: null,
      type: "text/plain",
    });
    expect(resolution.candidates).toEqual([
      {
        mode: "read",
        moduleId: "plain",
        moduleName: "Plain",
        view: "edit",
        viewTitle: "Plain editor",
      },
    ]);
  });
});

describe("remembered editor", () => {
  const other = { ...markdown, moduleId: "other", moduleName: "Other" };

  it("applies only while several editors match and it is one of them", () => {
    const remembered = {
      "text/markdown": { moduleId: "other", view: "edit" },
    };
    expect(
      resolveEditors({
        editors: [markdown, other],
        entryMime: null,
        preferences: remembered,
        type: "text/markdown",
      }).preferred
    ).toMatchObject({ moduleId: "other" });
    expect(
      resolveEditors({
        editors: [markdown],
        entryMime: null,
        preferences: {
          "text/markdown": { moduleId: "markdown", view: "edit" },
        },
        type: "text/markdown",
      }).preferred
    ).toBeNull();
    expect(
      resolveEditors({
        editors: [markdown, { ...other, moduleId: "third" }],
        entryMime: null,
        preferences: remembered,
        type: "text/markdown",
      }).preferred
    ).toBeNull();
  });

  it("is keyed by the MIME type the editors matched on", () => {
    expect(
      resolveEditors({
        editors: [markdown, other],
        entryMime: "text/markdown",
        preferences: { "text/markdown": { moduleId: "other", view: "edit" } },
        type: "application/vnd.example.notes",
      }).preferred
    ).toMatchObject({ moduleId: "other" });
  });
});

function content(
  files: string[],
  metadata: Content["metadata"] = {}
): Pick<Content, "metadata" | "tree"> {
  return {
    metadata,
    tree: Object.fromEntries([
      ["assets", { type: "directory" }],
      ...files.map((path) => [
        path,
        {
          bytes: 3,
          digest: "0".repeat(64),
          mime: path.endsWith(".md") ? "text/markdown" : null,
          type: "file",
        },
      ]),
    ]),
  };
}

describe("entry choice", () => {
  it("uses the declared primary entry without asking", () => {
    expect(
      chooseEntry(content(["a.md", "b.md"], { entry: "b.md" }))
    ).toMatchObject({
      entry: { mime: "text/markdown", path: "b.md" },
      kind: "entry",
    });
  });

  it("uses the only file without asking", () => {
    expect(chooseEntry(content(["a.md"]))).toMatchObject({
      entry: { path: "a.md" },
      kind: "entry",
    });
  });

  it("uses root index.html, the package's documented default", () => {
    expect(chooseEntry(content(["index.html", "style.css"]))).toMatchObject({
      entry: { path: "index.html" },
      kind: "entry",
    });
  });

  it("asks among every file, by path, when there is no primary entry", () => {
    expect(chooseEntry(content(["b.md", "a.md", "assets/c.png"]))).toEqual({
      entries: [
        { bytes: 3, mime: "text/markdown", path: "a.md" },
        { bytes: 3, mime: null, path: "assets/c.png" },
        { bytes: 3, mime: "text/markdown", path: "b.md" },
      ],
      kind: "entries",
    });
  });

  it("asks rather than substituting another file for a missing declared entry", () => {
    expect(
      chooseEntry(content(["a.md", "b.md"], { entry: "gone.md" }))
    ).toMatchObject({ kind: "entries" });
    expect(chooseEntry(content(["a.md"], { entry: "gone.md" }))).toMatchObject({
      entries: [{ path: "a.md" }],
      kind: "entries",
    });
  });

  it("opens a requested file, and refuses one that is not a file", () => {
    expect(chooseEntry(content(["a.md", "b.md"]), "b.md")).toMatchObject({
      entry: { path: "b.md" },
      kind: "entry",
    });
    expect(chooseEntry(content(["a.md", "b.md"]), "c.md")).toBeNull();
    expect(chooseEntry(content(["a.md", "b.md"]), "assets")).toBeNull();
  });

  it("has nothing to open without files", () => {
    expect(chooseEntry(content([]))).toEqual({ kind: "empty" });
  });
});
