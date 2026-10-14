import { describe, expect, it } from "vitest";
import { createMarkdownRenderer } from "../../src/lib/render/markdown";
import type { BlockView } from "../../src/lib/render/views";

const markdown = createMarkdownRenderer();

describe("markdown blocks", () => {
  it("renders label/value rows as a headerless table", () => {
    const view: BlockView = {
      kind: "labelValue",
      rows: [
        { label: "Target", value: "@foundry/workspaces" },
        { label: "Path", value: "packages/workspaces" },
      ],
    };
    expect(markdown.block(view)).toEqual([
      "|  |  |",
      "| --- | --- |",
      "| Target | @foundry/workspaces |",
      "| Path | packages/workspaces |",
    ]);
  });

  it("renders ratios and distributions as right-aligned share tables", () => {
    const ratio: BlockView = {
      items: [
        {
          denominator: 164,
          label: "External surface",
          numerator: 35,
          value: 0.213,
        },
      ],
      kind: "ratio",
    };
    expect(markdown.block(ratio)).toEqual([
      "|  | Share |  |",
      "| --- | ---: | --- |",
      "| External surface | 21.3% | 35 of 164 |",
    ]);
    const distribution: BlockView = {
      items: [{ detail: "19 symbols", label: "@foundry/db", share: 0.582 }],
      kind: "distribution",
    };
    expect(markdown.block(distribution)[2]).toBe(
      "| @foundry/db | 58.2% | 19 symbols |"
    );
  });

  it("keeps the funnel in a fenced block", () => {
    const view: BlockView = {
      kind: "funnel",
      stages: [
        { label: "total symbols", value: 164 },
        { label: "externally used", value: 35 },
      ],
    };
    expect(markdown.block(view)).toEqual([
      "```",
      "164 total symbols",
      " 35 externally used",
      "```",
    ]);
  });

  it("renders signals as a bold title, summary, and bullets", () => {
    const view: BlockView = {
      evidence: ["consumer packages 1", "one way dependency yes"],
      kind: "signal",
      summary: "behaves as an internal subsystem",
      title: "FOLD CANDIDATE",
      tone: "emphasis",
    };
    expect(markdown.block(view)).toEqual([
      "**◇ FOLD CANDIDATE**\\",
      "behaves as an internal subsystem",
      "",
      "- consumer packages 1",
      "- one way dependency yes",
    ]);
  });

  it("renders gates as a task list", () => {
    const view: BlockView = {
      checks: [
        { label: "single-consumer  expected 1 · actual 3", passed: false },
        { label: "one-way dependency", passed: true },
      ],
      kind: "gate",
      result: "NOT ELIGIBLE",
      title: "FOLD PACKAGE ELIGIBILITY",
    };
    expect(markdown.block(view)).toEqual([
      "**FOLD PACKAGE ELIGIBILITY**",
      "",
      "- [ ] single-consumer  expected 1 · actual 3",
      "- [x] one-way dependency",
      "",
      "Result: **NOT ELIGIBLE**",
    ]);
  });

  it("renders lists as bullets with overflow, and ranked lists as tables", () => {
    const list: BlockView = {
      items: ["ArtifactRead"],
      kind: "list",
      overflow: 2,
    };
    expect(markdown.block(list)).toEqual(["* ArtifactRead", "* … 2 more"]);
    const ranked: BlockView = {
      items: [{ detail: ["type · 23 refs"], label: "WorkspaceId", value: 2 }],
      kind: "rankedList",
    };
    expect(markdown.block(ranked)).toEqual([
      "|  | Value |  |",
      "| --- | ---: | --- |",
      "| WorkspaceId | 2 | type · 23 refs |",
    ]);
  });

  it("turns text lines into paragraphs with hard breaks and escapes pipes", () => {
    const view: BlockView = {
      kind: "text",
      lines: ["  first", "second", "", "third"],
    };
    expect(markdown.block(view)).toEqual(["first\\", "second", "", "third"]);
    const rows: BlockView = {
      kind: "labelValue",
      rows: [{ label: "a | b", value: "c" }],
    };
    expect(markdown.block(rows)[2]).toBe("| a \\| b | c |");
  });

  it("renders notes as blockquotes", () => {
    const view: BlockView = {
      kind: "note",
      lines: ["Declared intent.", "", "Signals still fire."],
      title: "Anchor",
    };
    expect(markdown.block(view)).toEqual([
      "> **Anchor**",
      ">",
      "> Declared intent.",
      ">",
      "> Signals still fire.",
    ]);
  });

  it("nests sections under a title heading with blank lines between blocks", () => {
    const rendered = markdown.report({
      sections: [
        { blocks: [{ kind: "text", lines: ["intro"] }] },
        {
          blocks: [
            { kind: "text", lines: ["one"] },
            { kind: "text", lines: ["two"] },
          ],
          title: "SUMMARY",
        },
      ],
      title: "SEMANTIC SURFACE",
    });
    expect(rendered).toBe(
      [
        "# SEMANTIC SURFACE",
        "",
        "intro",
        "",
        "## SUMMARY",
        "",
        "one",
        "",
        "two",
        "",
      ].join("\n")
    );
  });
});
