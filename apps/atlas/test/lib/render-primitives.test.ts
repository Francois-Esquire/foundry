import { describe, expect, it } from "vitest";

import type { BlockView, RenderContext } from "../../src/lib/render";

import {
  createTerminalRenderer,
  createTextRenderer,
  DEFAULT_CONTEXT,
  displayWidth,
  truncateDisplay,
} from "../../src/lib/render";

const ESC = String.fromCharCode(27);

const terminal = (overrides: Partial<RenderContext> = {}) =>
  createTerminalRenderer({
    ...DEFAULT_CONTEXT,
    format: "terminal",
    ...overrides,
  });
const text = (overrides: Partial<RenderContext> = {}) =>
  createTextRenderer({ ...DEFAULT_CONTEXT, ...overrides });

const ratio: BlockView = {
  items: [
    {
      denominator: 164,
      label: "External surface",
      numerator: 35,
      value: 0.213,
    },
    { label: "Export utilization", value: 1 },
  ],
  kind: "ratio",
};

describe("ratio", () => {
  it("draws a bar at normal width and shows the fraction", () => {
    expect(terminal().block(ratio)).toEqual([
      "External surface    ████░░░░░░░░░░░░░░░░   21.3%  35 of 164",
      "Export utilization  ████████████████████  100.0%",
    ]);
  });

  it("shrinks the bar at narrow width and grows it at wide width", () => {
    expect(terminal({ width: 60 }).block(ratio)[0]).toContain("███░░░░░░░░░");
    expect(terminal({ width: 120 }).block(ratio)[1]).toContain(
      "██████████████████████████████"
    );
  });

  it("uses ASCII bars without unicode", () => {
    expect(terminal({ unicode: false }).block(ratio)[0]).toBe(
      "External surface    ####----------------   21.3%  35 of 164"
    );
  });

  it("prints numbers only in text", () => {
    expect(text().block(ratio)).toEqual([
      "External surface     21.3%  35 of 164",
      "Export utilization  100.0%",
    ]);
  });

  it("keeps alignment when color is on", () => {
    const lines = terminal({ color: true }).block(ratio);
    expect(lines[0]).toContain(`${ESC}[2m35 of 164${ESC}[22m`);
    expect(displayWidth(lines[0] ?? "")).toBe(
      displayWidth(terminal().block(ratio)[0] ?? "")
    );
  });
});

describe("funnel", () => {
  it("right-aligns counts", () => {
    const view: BlockView = {
      kind: "funnel",
      stages: [
        { label: "total symbols", value: 164 },
        { label: "exported", value: 88 },
        { label: "externally used", value: 35 },
      ],
    };
    expect(text().block(view)).toEqual([
      "164 total symbols",
      " 88 exported",
      " 35 externally used",
    ]);
  });
});

describe("distribution", () => {
  const view: BlockView = {
    items: [
      { detail: "19 symbols · 82 refs", label: "@foundry/db", share: 0.582 },
      { label: "@foundry/studio", share: 0.418 },
    ],
    kind: "distribution",
  };

  it("draws shares as bars in the terminal", () => {
    expect(terminal().block(view)).toEqual([
      "@foundry/db      ████████████░░░░░░░░  58.2%  19 symbols · 82 refs",
      "@foundry/studio  ████████░░░░░░░░░░░░  41.8%",
    ]);
  });

  it("prints shares as numbers in text", () => {
    expect(text().block(view)).toEqual([
      "@foundry/db      58.2%  19 symbols · 82 refs",
      "@foundry/studio  41.8%",
    ]);
  });
});

describe("rankedList", () => {
  const view: BlockView = {
    items: [
      { detail: ["type · 2 packages"], label: "WorkspaceId", value: 23 },
      { label: "newRoot", value: 13 },
    ],
    kind: "rankedList",
    overflow: 3,
  };

  it("scales bars to the largest value and lists overflow", () => {
    expect(terminal().block(view)).toEqual([
      "WorkspaceId  ████████████████████  23",
      "  type · 2 packages",
      "newRoot      ███████████░░░░░░░░░  13",
      "… 3 more",
    ]);
  });

  it("degrades to label and value in ASCII text", () => {
    expect(text({ unicode: false }).block(view)).toEqual([
      "WorkspaceId  23",
      "  type · 2 packages",
      "newRoot      13",
      "... 3 more",
    ]);
  });

  it("right-aligns values of different widths", () => {
    const mixed: BlockView = {
      items: [
        { label: "a", value: 123 },
        { label: "b", value: 7 },
      ],
      kind: "rankedList",
    };
    expect(text().block(mixed)).toEqual(["a  123", "b    7"]);
  });

  it("truncates labels wider than the label budget", () => {
    const long: BlockView = {
      items: [
        {
          label: "packages/workspaces/src/very/long/path/to/module.ts",
          value: 1,
        },
      ],
      kind: "rankedList",
    };
    expect(text({ width: 40 }).block(long)[0]).toBe("packages/worksp…  1");
  });
});

describe("list", () => {
  it("lists items with the shared overflow line", () => {
    const view: BlockView = {
      items: ["ArtifactRead", "classifyFile"],
      kind: "list",
      overflow: 28,
    };
    expect(text().block(view)).toEqual([
      "ArtifactRead",
      "classifyFile",
      "… 28 more",
    ]);
    expect(text({ unicode: false }).block(view)[2]).toBe("... 28 more");
  });
});

describe("signal", () => {
  it("prefixes the tone glyph and indents summary and evidence", () => {
    const view: BlockView = {
      evidence: ["1 consumer package", "one-way dependency"],
      kind: "signal",
      summary: "@foundry/db holds 58.2% of references",
      title: "CONCENTRATED CONSUMPTION",
      tone: "neutral",
    };
    expect(text().block(view)).toEqual([
      "◇ CONCENTRATED CONSUMPTION",
      "  @foundry/db holds 58.2% of references",
      "  • 1 consumer package",
      "  • one-way dependency",
    ]);
  });

  it("keeps meaning in the glyph when color is off and unicode is off", () => {
    const blocked: BlockView = {
      kind: "signal",
      title: "BLOCKED",
      tone: "blocked",
    };
    const anchored: BlockView = {
      kind: "signal",
      title: "Anchored",
      tone: "anchored",
    };
    const caution: BlockView = {
      kind: "signal",
      title: "Caution",
      tone: "caution",
    };
    expect(text({ unicode: false }).block(blocked)).toEqual(["[x] BLOCKED"]);
    expect(text({ unicode: false }).block(anchored)).toEqual([
      "[anchor] Anchored",
    ]);
    expect(text({ unicode: false }).block(caution)).toEqual(["! Caution"]);
  });

  it("wraps summaries at metric separators and evidence on words", () => {
    const view: BlockView = {
      evidence: [
        "Source package is an anchored boundary: Intentional subsystem boundary.",
      ],
      kind: "signal",
      summary:
        "import sites 20 · symbols 19 · references 82 · surface coverage 0.26",
      title: "boundary-pressure",
      tone: "neutral",
    };
    expect(text({ width: 44 }).block(view)).toEqual([
      "◇ boundary-pressure",
      "  import sites 20 · symbols 19",
      "  references 82 · surface coverage 0.26",
      "  • Source package is an anchored",
      "    boundary: Intentional subsystem",
      "    boundary.",
    ]);
  });

  it("colors only caution and blocked", () => {
    const styled = terminal({ color: true });
    expect(
      styled.block({ kind: "signal", title: "x", tone: "neutral" })[0]
    ).toBe("◇ x");
    expect(
      styled.block({ kind: "signal", title: "x", tone: "caution" })[0]
    ).toBe(`${ESC}[33m△ x${ESC}[39m`);
    expect(
      styled.block({ kind: "signal", title: "x", tone: "blocked" })[0]
    ).toBe(`${ESC}[31m■ x${ESC}[39m`);
  });
});

describe("gate", () => {
  it("lists checks with pass and fail glyphs", () => {
    const view: BlockView = {
      checks: [
        { label: "exactly one consumer", passed: true },
        { label: "boundary anchored", passed: false },
      ],
      kind: "gate",
      result: "BLOCKED",
      title: "FOLD ELIGIBILITY",
    };
    expect(text().block(view)).toEqual([
      "FOLD ELIGIBILITY",
      "✓ exactly one consumer",
      "✕ boundary anchored",
      "",
      "Result  BLOCKED",
    ]);
    expect(text({ unicode: false }).block(view).slice(1, 3)).toEqual([
      "ok exactly one consumer",
      "-- boundary anchored",
    ]);
  });
});

describe("edge", () => {
  it("draws the flow glyph with an indented muted label", () => {
    const view: BlockView = {
      from: "@deps/satellite",
      kind: "edge",
      label: "evidence confidence 100.0%",
      to: "@deps/parent",
    };
    expect(text().block(view)).toEqual([
      "@deps/satellite → @deps/parent",
      "  evidence confidence 100.0%",
    ]);
    expect(text({ unicode: false }).block(view)[0]).toBe(
      "@deps/satellite -> @deps/parent"
    );
  });
});

describe("note", () => {
  it("frames wrapped lines in a titled box, ASCII when unicode is off", () => {
    const view: BlockView = {
      kind: "note",
      lines: ["Declared intent. Only folding this package away is blocked."],
      title: "Anchor",
    };
    expect(text({ width: 44 }).block(view)).toEqual([
      "┌─ Anchor ───────────────────────────┐",
      "│ Declared intent. Only folding this │",
      "│ package away is blocked.           │",
      "└────────────────────────────────────┘",
    ]);
    expect(text({ unicode: false, width: 44 }).block(view)[0]).toBe(
      "+- Anchor ---------------------------+"
    );
  });
});

describe("width", () => {
  it("measures past ANSI escapes and wide glyphs", () => {
    expect(displayWidth(`${ESC}[1mabc${ESC}[22m`)).toBe(3);
    expect(displayWidth("█░")).toBe(2);
  });

  it("truncates by display width", () => {
    expect(truncateDisplay("abcdef", 4, "…")).toBe("abc…");
    expect(truncateDisplay("abc", 4, "…")).toBe("abc");
  });
});

describe("report", () => {
  it("styles headings in the terminal and rules to the title width", () => {
    const rendered = terminal({ color: true }).report({
      sections: [
        { blocks: [{ kind: "text", lines: ["body"] }], title: "SECTION" },
      ],
      title: "TITLE",
    });
    expect(rendered).toBe(
      [
        `${ESC}[1mTITLE${ESC}[22m`,
        "═════",
        "",
        `${ESC}[1mSECTION${ESC}[22m`,
        "  body",
      ].join("\n")
    );
  });
});
