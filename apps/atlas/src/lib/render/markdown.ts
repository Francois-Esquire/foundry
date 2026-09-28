import { percent } from "./format";
import type { Renderer } from "./renderer";
import { glyphsFor, toneGlyph } from "./theme";
import type { BlockView, ReportView, SectionView } from "./views";

const cellPattern = /\|/g;

const glyphs = glyphsFor(true);

/** A Markdown table; empty header cells are allowed and render blank. */
function table(
  header: string[],
  align: ("left" | "right")[],
  rows: string[][]
): string[] {
  const cell = (text: string) => text.replace(cellPattern, "\\|");
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [
    line(header),
    `| ${align.map((a) => (a === "right" ? "---:" : "---")).join(" | ")} |`,
    ...rows.map(line),
  ];
}

/** Lines that must stay on separate lines inside one paragraph. */
function hardBreaks(lines: string[]): string[] {
  return lines.map((line, index) =>
    index < lines.length - 1 ? `${line}\\` : line
  );
}

/**
 * Markdown uses Markdown semantics: headings, tables, bullets, task lists,
 * fenced blocks for line art. Width, color, and ASCII fallback do not apply;
 * the viewer wraps and the file is UTF-8.
 */
export function createMarkdownRenderer(): Renderer {
  const block = (view: BlockView): string[] => blockKind(view);

  const section = (view: SectionView): string[] => {
    const body = view.blocks
      .map(block)
      .filter((lines) => lines.length > 0)
      .flatMap((lines) => ["", ...lines]);
    if (view.title === undefined) {
      return body.slice(1);
    }
    return ["", `## ${view.title}`, ...body];
  };

  const report = (view: ReportView): string =>
    [`# ${view.title}`, "", ...view.sections.flatMap(section), ""].join("\n");

  return { block, report, section };
}

function blockKind(view: BlockView) {
  switch (view.kind) {
    case "text": {
      const paragraphs: string[][] = [[]];
      for (const line of view.lines) {
        if (line === "") {
          paragraphs.push([]);
        } else {
          paragraphs.at(-1)?.push(line.trim());
        }
      }
      return paragraphs
        .filter((paragraph) => paragraph.length > 0)
        .flatMap((paragraph, index) => [
          ...(index > 0 ? [""] : []),
          ...hardBreaks(paragraph),
        ]);
    }
    case "labelValue":
      return table(
        ["", ""],
        ["left", "left"],
        view.rows.map((row) => [row.label, row.value])
      );
    case "ratio":
      return table(
        ["", "Share", ""],
        ["left", "right", "left"],
        view.items.map((item) => [
          item.label,
          percent(item.value),
          item.numerator !== undefined && item.denominator !== undefined
            ? `${item.numerator} of ${item.denominator}`
            : "",
        ])
      );
    case "funnel": {
      const width = Math.max(
        0,
        ...view.stages.map((stage) => String(stage.value).length)
      );
      return [
        "```",
        ...view.stages.map(
          (stage) => `${String(stage.value).padStart(width)} ${stage.label}`
        ),
        "```",
      ];
    }
    case "distribution":
      return table(
        ["", "Share", ""],
        ["left", "right", "left"],
        view.items.map((item) => [
          item.label,
          percent(item.share),
          item.detail ?? "",
        ])
      );
    case "rankedList":
      return [
        ...table(
          ["", "Value", ""],
          ["left", "right", "left"],
          view.items.map((item) => [
            item.label,
            String(item.value),
            (item.detail ?? []).join("; "),
          ])
        ),
        ...(view.overflow !== undefined && view.overflow > 0
          ? ["", `${glyphs.overflow} ${view.overflow} more`]
          : []),
      ];
    case "list":
      // `*` so a list after signal evidence (`-`) starts a new list.
      return [
        ...view.items.map((item) => `* ${item}`),
        ...(view.overflow !== undefined && view.overflow > 0
          ? [`* ${glyphs.overflow} ${view.overflow} more`]
          : []),
      ];
    case "signal": {
      const head = [`**${toneGlyph(glyphs, view.tone)} ${view.title}**`];
      if (view.summary !== undefined) {
        head.push(view.summary);
      }
      const evidence = view.evidence ?? [];
      return [
        ...hardBreaks(head),
        ...(evidence.length > 0
          ? ["", ...evidence.map((item) => `- ${item}`)]
          : []),
      ];
    }
    case "gate":
      return [
        `**${view.title}**`,
        "",
        ...view.checks.map(
          (check) => `- [${check.passed ? "x" : " "}] ${check.label}`
        ),
        "",
        `Result: **${view.result}**`,
      ];
    case "note":
      return [
        `> **${view.title}**`,
        ">",
        ...view.lines.map((line) => (line === "" ? ">" : `> ${line}`)),
      ];
    case "edge": {
      const head = [`${view.from} ${glyphs.flow} ${view.to}`];
      if (view.label !== undefined) {
        head.push(view.label);
      }
      return hardBreaks(head);
    }
    default:
      throw new Error("Unexpected view.kind.");
  }
}
