import type { Size } from "@/model/screen";

export type FrameTone = "line" | "stud" | "label" | "meta";

export interface FrameSegment {
  readonly text: string;
  readonly tone: FrameTone;
}

export interface RailRule {
  readonly meta?: string;
  readonly row: number;
  readonly title: string;
}

export interface RailSectionSpec {
  readonly height: number | "fill";
  readonly key: string;
  readonly meta?: string;
  readonly title?: string;
}

export interface RailSlot {
  readonly height: number;
  readonly key: string;
  readonly top: number;
}

export interface FrameSpec {
  readonly goalRow: number;
  readonly rail: number;
  readonly rules: readonly RailRule[];
  readonly size: Size;
  readonly title: string;
}

const STUD = "◆";
const STUD_INSET = 4;
const TITLE_INSET = 5;
const GOAL_HEIGHT = 1;

export function hudGeometry({ height, width }: Size, rail: number) {
  const goalRow = height - GOAL_HEIGHT - 2;
  return {
    goalRow,
    goalTop: goalRow + 1,
    mainHeight: Math.max(goalRow - 1, 0),
    mainLeft: rail,
    mainWidth: Math.max(width - rail - 1, 0),
    railInner: rail - 2,
  };
}

export function railPlan(
  sections: readonly RailSectionSpec[],
  height: number
): { readonly rules: RailRule[]; readonly slots: RailSlot[] } {
  const room = Math.max(height - 2, 0);
  const fixed = sections.reduce(
    (total, section, index) =>
      total +
      (section.height === "fill" ? 0 : section.height) +
      (index === 0 ? 0 : 1),
    0
  );
  const fill = Math.max(room - fixed, 0);
  const rules: RailRule[] = [];
  const slots: RailSlot[] = [];
  let row = 1;
  for (const [index, section] of sections.entries()) {
    if (index > 0) {
      rules.push({ meta: section.meta, row, title: section.title ?? "" });
      row += 1;
    }
    const wanted = section.height === "fill" ? fill : section.height;
    const fits = Math.max(Math.min(wanted, height - 1 - row), 0);
    slots.push({ height: fits, key: section.key, top: row });
    row += fits;
  }
  return { rules: rules.filter((rule) => rule.row < height - 1), slots };
}

interface Cells {
  readonly chars: string[];
  readonly tones: FrameTone[];
}

function blank(width: number, fill: string): Cells {
  return {
    chars: new Array<string>(width).fill(fill),
    tones: new Array<FrameTone>(width).fill("line"),
  };
}

function put(cells: Cells, at: number, text: string, tone: FrameTone) {
  for (const [offset, char] of [...text].entries()) {
    const x = at + offset;
    if (x > 0 && x < cells.chars.length - 1) {
      cells.chars[x] = char;
      cells.tones[x] = tone;
    }
  }
}

function segments({ chars, tones }: Cells): FrameSegment[] {
  const found: { text: string; tone: FrameTone }[] = [];
  for (const [x, char] of chars.entries()) {
    const tone = tones[x] ?? "line";
    const last = found.at(-1);
    if (last && last.tone === tone) {
      last.text += char;
    } else {
      found.push({ text: char, tone });
    }
  }
  return found;
}

function shortened(text: string, room: number): string {
  if (room < 2) {
    return "";
  }
  return text.length > room ? `${text.slice(0, room - 1)}…` : text;
}

function edge(
  { rail, size, title }: FrameSpec,
  [left, joint, right]: readonly [string, string, string]
): Cells {
  const cells = blank(size.width, "═");
  for (const x of [
    STUD_INSET,
    rail - 1 - STUD_INSET,
    size.width - 1 - STUD_INSET,
  ]) {
    put(cells, x, STUD, "stud");
  }
  put(cells, rail + 2, STUD, "stud");
  const label = shortened(title, size.width - rail - TITLE_INSET - 8);
  if (label) {
    put(cells, rail + TITLE_INSET - 1, ` ${label} `, "meta");
  }
  cells.chars[0] = left;
  cells.chars[rail - 1] = joint;
  cells.chars[size.width - 1] = right;
  return cells;
}

function body({ goalRow, rail, rules, size }: FrameSpec, row: number): Cells {
  const cells = blank(size.width, " ");
  const rule = rules.find((each) => each.row === row);
  const goal = row === goalRow;
  cells.chars[0] = rule ? "╟" : "║";
  cells.chars[size.width - 1] = goal ? "╣" : "║";
  if (goal) {
    cells.chars.fill("═", rail, size.width - 1);
  }
  if (rule) {
    cells.chars.fill("─", 1, rail - 1);
    put(cells, 3, STUD, "stud");
    const meta = rule.meta ? ` ${rule.meta} ` : "";
    put(
      cells,
      TITLE_INSET - 1,
      ` ${shortened(rule.title, rail - 8 - meta.length)} `,
      "label"
    );
    put(cells, rail - 2 - meta.length, meta, "meta");
  }
  cells.chars[rail - 1] = jointAt(Boolean(rule), goal);
  return cells;
}

function jointAt(rule: boolean, goal: boolean): string {
  if (goal) {
    return rule ? "╬" : "╠";
  }
  return rule ? "╢" : "║";
}

export function frameRows(spec: FrameSpec): FrameSegment[][] {
  const { height } = spec.size;
  return Array.from({ length: height }, (_, row) => {
    if (row === 0) {
      return segments(edge(spec, ["╔", "╦", "╗"]));
    }
    if (row === height - 1) {
      return segments(edge({ ...spec, title: "" }, ["╚", "╩", "╝"]));
    }
    return segments(body(spec, row));
  });
}
