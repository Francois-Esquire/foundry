import { percent } from "./format";
import { indent, labelValueLines, wrap } from "./layout";
import type { Renderer } from "./renderer";
import type { Glyphs, RenderTheme } from "./theme";
import { toneGlyph, toneStyle } from "./theme";
import type {
  BlockView,
  DistributionItem,
  FunnelStage,
  GateCheck,
  RankedItem,
  RatioItem,
  ReportView,
  SectionView,
  Tone,
} from "./views";
import { displayWidth, padDisplay, truncateDisplay } from "./width";

export interface BlockStyle {
  /** Cells in a full bar; 0 draws no bars and prints numbers only. */
  barCells: number;
  glyphs: Glyphs;
  /** Widest label before truncation. */
  labelCells: number;
  theme: RenderTheme;
  /** Cells available to a wrapped prose line inside a section. */
  wrapCells: number;
}

/** Right-aligns a numeric column to its widest cell. */
function rightAligned(values: readonly string[]): string[] {
  const width = Math.max(0, ...values.map(displayWidth));
  return values.map((value) => value.padStart(width));
}

/**
 * Text and terminal share every primitive; they differ only in style. A
 * target that cannot draw a bar prints the number the bar would have shown.
 */
export function createRenderer(style: BlockStyle): Renderer {
  const { theme, glyphs } = style;

  const label = (text: string): string =>
    truncateDisplay(text, style.labelCells, glyphs.overflow);

  const bar = (share: number): string => {
    if (style.barCells === 0) {
      return "";
    }
    const filled = Math.round(Math.min(1, Math.max(0, share)) * style.barCells);
    return `${glyphs.fill.repeat(filled)}${glyphs.empty.repeat(style.barCells - filled)}`;
  };

  const cells = (parts: (string | undefined)[]): string =>
    parts.filter((part) => part !== undefined && part !== "").join("  ");

  /** One row per item: padded label, bar, right-aligned number, muted detail. */
  const rows = <T>(
    items: readonly T[],
    pick: (item: T) => {
      label: string;
      share: number;
      value: string;
      detail?: string;
    }
  ): string[] => {
    const picked = items.map(pick);
    const labels = picked.map((item) => label(item.label));
    const labelWidth = Math.max(0, ...labels.map(displayWidth));
    const values = rightAligned(picked.map((item) => item.value));
    return picked.map((item, index) =>
      cells([
        padDisplay(labels[index] ?? "", labelWidth),
        bar(item.share),
        values[index],
        item.detail === undefined ? undefined : theme.muted(item.detail),
      ])
    );
  };

  const ratio = (items: RatioItem[]): string[] =>
    rows(items, (item) => ({
      label: item.label,
      share: item.value,
      value: percent(item.value),
      ...(item.numerator !== undefined &&
        item.denominator !== undefined && {
          detail: `${item.numerator} of ${item.denominator}`,
        }),
    }));

  const funnel = (stages: FunnelStage[]): string[] => {
    const values = rightAligned(stages.map((stage) => String(stage.value)));
    return stages.map(
      (stage, index) => `${values[index] ?? ""} ${stage.label}`
    );
  };

  const distribution = (items: DistributionItem[]): string[] =>
    rows(items, (item) => ({
      label: item.label,
      share: item.share,
      value: percent(item.share),
      ...(item.detail !== undefined && { detail: item.detail }),
    }));

  const overflowLine = (overflow: number | undefined): string[] =>
    overflow !== undefined && overflow > 0
      ? [theme.muted(`${glyphs.overflow} ${overflow} more`)]
      : [];

  const rankedList = (items: RankedItem[], overflow?: number): string[] => {
    const max = Math.max(0, ...items.map((item) => item.value));
    const heads = rows(items, (item) => ({
      label: item.label,
      share: max === 0 ? 0 : item.value / max,
      value: String(item.value),
    }));
    return [
      ...items.flatMap((item, index) => [
        heads[index] ?? "",
        ...indent(item.detail ?? []),
      ]),
      ...overflowLine(overflow),
    ];
  };

  const list = (items: string[], overflow?: number): string[] => [
    ...items,
    ...overflowLine(overflow),
  ];

  const signal = (
    title: string,
    tone: Tone,
    summary?: string,
    evidence?: string[]
  ): string[] => {
    const styled = toneStyle(theme, tone);
    const [head = "", ...rest] = wrap(title, style.wrapCells - 2);
    const lines = [
      styled(`${toneGlyph(glyphs, tone)} ${head}`),
      ...indent(rest.map(styled)),
    ];
    if (summary !== undefined) {
      lines.push(...indent(wrap(summary, style.wrapCells)));
    }
    for (const item of evidence ?? []) {
      const [head = "", ...rest] = wrap(item, style.wrapCells - 2);
      lines.push(...indent([`${glyphs.bullet} ${head}`, ...indent(rest)]));
    }
    return lines;
  };

  const gate = (
    title: string,
    checks: GateCheck[],
    result: string
  ): string[] => [
    theme.emphasis(title),
    ...checks.map(
      (check) => `${check.passed ? glyphs.pass : glyphs.fail} ${check.label}`
    ),
    "",
    `Result  ${theme.emphasis(result)}`,
  ];

  const edge = (from: string, to: string, detail?: string): string[] => {
    const line = `${from} ${glyphs.flow} ${to}`;
    return detail === undefined
      ? [line]
      : [line, ...indent([theme.muted(detail)])];
  };

  /** Framed aside; the only box in the vocabulary, reserved for teaching. */
  const note = (title: string, lines: string[]): string[] => {
    const { box } = glyphs;
    const inner = Math.max(20, style.wrapCells - 4);
    const body = lines.flatMap((line) =>
      line === "" ? [""] : wrap(line, inner)
    );
    const width = Math.max(
      displayWidth(title) + 4,
      ...body.map((line) => displayWidth(line) + 2)
    );
    const top = `${box.topLeft}${box.horizontal} ${title} ${box.horizontal.repeat(width - displayWidth(title) - 3)}${box.topRight}`;
    const bottom = `${box.bottomLeft}${box.horizontal.repeat(width)}${box.bottomRight}`;
    return [
      theme.muted(top),
      ...body.map((line) =>
        theme.muted(
          `${box.vertical} ${padDisplay(line, width - 2)} ${box.vertical}`
        )
      ),
      theme.muted(bottom),
    ];
  };

  const block = (view: BlockView): string[] => {
    switch (view.kind) {
      case "note":
        return note(view.title, view.lines);
      case "text":
        return view.lines;
      case "labelValue":
        return labelValueLines(view.rows);
      case "ratio":
        return ratio(view.items);
      case "funnel":
        return funnel(view.stages);
      case "distribution":
        return distribution(view.items);
      case "rankedList":
        return rankedList(view.items, view.overflow);
      case "list":
        return list(view.items, view.overflow);
      case "signal":
        return signal(view.title, view.tone, view.summary, view.evidence);
      case "gate":
        return gate(view.title, view.checks, view.result);
      case "edge":
        return edge(view.from, view.to, view.label);
    }
  };

  const section = (view: SectionView): string[] => {
    const body = view.blocks.flatMap(block);
    if (view.title === undefined) {
      return body;
    }
    return ["", theme.heading(view.title), ...indent(body)];
  };

  const report = (view: ReportView): string =>
    [
      theme.heading(view.title),
      glyphs.rule.repeat(displayWidth(view.title)),
      ...view.sections.flatMap(section),
    ].join("\n");

  return { block, report, section };
}
