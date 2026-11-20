import { grain, lifted, sunken } from "@/model/grain";
import { hud, tones } from "@/model/palette";
import {
  type ArtRow,
  type Canvas,
  createCanvas,
  etch,
  fill,
  type Label,
  rasterize,
} from "@/model/pixels";
import type { Size } from "@/model/screen";

export interface Rect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface HudPart {
  readonly grow?: boolean;
  readonly meta?: string;
  readonly rows?: number;
  readonly title?: string;
}

interface PartFrame {
  readonly body: Rect;
  readonly head: Rect;
  readonly inset: Rect;
}

export interface HudGeometry {
  readonly dense: boolean;
  readonly goal: Rect;
  readonly hints: Rect;
  readonly main: Rect;
  readonly parts: readonly PartFrame[];
  readonly rail: number;
  readonly screen: Rect;
  readonly slot: Rect;
  readonly steps: Rect;
}

const DENSE_HEIGHT = 28;
const DENSE_WIDTH = 90;
const RAIL_BODY = 22;
const STEP_ROWS = 3;
const GOAL_ROWS = 3;
const HINT_ROWS = 1;
const CAP = " >_ ";
const SEND = " ↵ ";
const PEDIMENT = "▁▂▃▄▅▆▇";

function bodyRows(parts: readonly HudPart[], available: number): number[] {
  const fixed = parts.reduce(
    (sum, part) => sum + (part.grow ? 0 : (part.rows ?? 1)),
    0
  );
  const growers = parts.filter((part) => part.grow).length;
  const share = growers
    ? Math.floor(Math.max(available - fixed, 0) / growers)
    : 0;
  let left = available;
  return parts.map((part) => {
    const rows = Math.max(
      Math.min(part.grow ? share : (part.rows ?? 1), left),
      0
    );
    left -= rows;
    return rows;
  });
}

export function hudGeometry(
  { height, width }: Size,
  parts: readonly HudPart[]
): HudGeometry {
  const dense = height < DENSE_HEIGHT || width < DENSE_WIDTH;
  const edge = dense ? 1 : Math.min(Math.floor(width / 40), 3);
  const head = dense ? 1 : 2;
  const rail = RAIL_BODY + 4 + edge * 2;
  const insetX = 1 + edge;
  const insetWidth = rail - 2 - edge * 2;
  const rows = bodyRows(parts, height - 1 - parts.length * head);
  let y = 0;
  const frames = rows.map((bodyHeight) => {
    const top = y;
    y += head + bodyHeight;
    return {
      body: {
        height: bodyHeight,
        width: insetWidth - 2,
        x: insetX + 1,
        y: top + head,
      },
      head: { height: head, width: rail - 1, x: 0, y: top },
      inset: {
        height: bodyHeight,
        width: insetWidth,
        x: insetX,
        y: top + head,
      },
    };
  });
  const innerX = rail + edge;
  const innerWidth = width - rail - edge * 2 - 1;
  const screenRows = height - STEP_ROWS - GOAL_ROWS - HINT_ROWS;
  const goalY = height - HINT_ROWS - GOAL_ROWS + 1;
  return {
    dense,
    goal: {
      height: 1,
      width: innerWidth - CAP.length - SEND.length - 3,
      x: innerX + CAP.length + 1,
      y: goalY,
    },
    hints: { height: 1, width: innerWidth, x: innerX, y: height - 1 },
    main: {
      height: screenRows,
      width: innerWidth - 4,
      x: innerX + 2,
      y: STEP_ROWS,
    },
    parts: frames,
    rail,
    screen: {
      height: screenRows,
      width: innerWidth,
      x: innerX,
      y: STEP_ROWS,
    },
    slot: { height: 1, width: innerWidth, x: innerX, y: goalY },
    steps: { height: STEP_ROWS, width: innerWidth, x: innerX, y: 0 },
  };
}

function sink(canvas: Canvas, labels: Label[], area: Rect) {
  if (area.height <= 0) {
    return;
  }
  const y = area.y * 2;
  const height = area.height * 2;
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  fill(canvas, { height, width: 1, x: area.x - 1, y }, sunken);
  fill(canvas, { height: height + 2, width: 1, x: right, y }, lifted);
  fill(
    canvas,
    { height: 2, width: area.width, x: area.x, y: bottom * 2 },
    lifted
  );
  fill(canvas, { height, width: area.width, x: area.x, y }, hud.screen);
  labels.push(
    ...etch(
      canvas,
      { height: area.height, x: right, y: area.y },
      "▏",
      hud.iron[6]
    ),
    ...etch(
      canvas,
      { width: area.width, x: area.x, y: bottom },
      "▔",
      hud.iron[6]
    )
  );
}

function notch(labels: Label[], area: Rect, depth: number) {
  const right = area.x + area.width - 1;
  const bottom = area.y + area.height - 1;
  const corner = (x: number, y: number, text: string) =>
    labels.push({
      bg: hud.screen,
      fg: depth > 1 ? hud.brass[3] : hud.grain[1],
      text,
      x,
      y,
    });
  if (depth > 1) {
    corner(area.x, area.y, "▛▀");
    corner(right - 1, area.y, "▀▜");
    corner(area.x, bottom, "▙▄");
    corner(right - 1, bottom, "▄▟");
    corner(area.x, area.y + 1, "▌");
    corner(right, area.y + 1, "▐");
    corner(area.x, bottom - 1, "▌");
    corner(right, bottom - 1, "▐");
    corner(area.x, area.y + 2, "▘");
    corner(right, area.y + 2, "▝");
    corner(area.x, bottom - 2, "▖");
    corner(right, bottom - 2, "▗");
    return;
  }
  corner(area.x, area.y, "▘");
  corner(right, area.y, "▝");
  corner(area.x, bottom, "▖");
  corner(right, bottom, "▗");
}

function rivet(canvas: Canvas, labels: Label[], x: number, y: number) {
  labels.push(
    ...etch(canvas, { x, y }, "▗", hud.iron[6]),
    ...etch(canvas, { x: x + 1, y }, "▖", hud.iron[6]),
    ...etch(canvas, { x, y: y + 1 }, "▝", hud.iron[1]),
    ...etch(canvas, { x: x + 1, y: y + 1 }, "▘", hud.iron[1])
  );
}

function pediment(canvas: Canvas, labels: Label[], centre: number, y: number) {
  for (const [step, mark] of [...PEDIMENT].entries()) {
    const reach = PEDIMENT.length - step;
    labels.push(
      ...etch(canvas, { x: centre - 1 - reach, y }, mark, hud.iron[6]),
      ...etch(canvas, { x: centre + reach, y }, mark, hud.iron[6])
    );
  }
  labels.push({
    bg: hud.amber,
    fg: tones.amber.glow,
    text: "▀▀",
    x: centre - 1,
    y,
  });
}

function header(
  canvas: Canvas,
  labels: Label[],
  frame: PartFrame,
  part: HudPart,
  dense: boolean
) {
  const textRow = frame.head.y + frame.head.height - 1;
  const left = frame.inset.x;
  const right = frame.inset.x + frame.inset.width;
  if (!dense) {
    fill(
      canvas,
      { height: 2, width: frame.head.width - 1, x: 1, y: frame.head.y * 2 },
      lifted
    );
    fill(
      canvas,
      { height: 2, width: frame.inset.width, x: left, y: textRow * 2 },
      sunken
    );
    rivet(canvas, labels, 1, frame.head.y);
    rivet(canvas, labels, frame.head.width - 2, frame.head.y);
  }
  if (dense && part.title) {
    labels.push(
      ...etch(
        canvas,
        { width: frame.inset.width, x: left, y: textRow },
        " ",
        hud.screen
      )
    );
  }
  if (!part.title) {
    pediment(canvas, labels, Math.floor((left + right) / 2), textRow);
    return;
  }
  const plaque = ` ${part.title} `;
  const meta = part.meta ? ` ${part.meta} ` : "";
  const plaqueX = left + 2;
  const metaX = right - 2 - meta.length;
  if (!dense) {
    labels.push(
      ...etch(
        canvas,
        { width: plaque.length, x: plaqueX, y: frame.head.y },
        "▂",
        hud.brass[4]
      )
    );
  }
  labels.push(
    ...etch(canvas, { x: plaqueX - 1, y: textRow }, "▐", hud.brass[2]),
    ...etch(
      canvas,
      { x: plaqueX + plaque.length, y: textRow },
      "▌",
      hud.brass[2]
    ),
    {
      bg: hud.brass[2],
      bold: true,
      fg: hud.brass[0],
      text: plaque,
      x: plaqueX,
      y: textRow,
    }
  );
  if (meta) {
    labels.push(
      ...etch(canvas, { x: metaX - 1, y: textRow }, "▐", hud.screen),
      ...etch(canvas, { x: metaX + meta.length, y: textRow }, "▌", hud.screen),
      { bg: hud.screen, fg: hud.brass[3], text: meta, x: metaX, y: textRow }
    );
  }
}

function goalBar(canvas: Canvas, labels: Label[], slot: Rect) {
  const x = slot.x + CAP.length;
  const width = slot.width - CAP.length;
  fill(canvas, { height: 2, width, x, y: slot.y * 2 }, hud.screen);
  labels.push(
    ...etch(canvas, { x: slot.x + slot.width, y: slot.y }, "▏", hud.iron[6]),
    ...etch(canvas, { width, x, y: slot.y + 1 }, "▔", hud.iron[6]),
    ...etch(
      canvas,
      { width: CAP.length, x: slot.x, y: slot.y - 1 },
      "▂",
      hud.brass[4]
    ),
    {
      bg: hud.brass[2],
      bold: true,
      fg: hud.brass[0],
      text: CAP,
      x: slot.x,
      y: slot.y,
    },
    { bg: hud.screen, fg: hud.brass[2], text: "▌", x, y: slot.y },
    {
      bg: tones.amber.deep,
      bold: true,
      fg: hud.amber,
      text: SEND,
      x: slot.x + slot.width - SEND.length,
      y: slot.y,
    }
  );
}

export function hudArt(size: Size, parts: readonly HudPart[]): ArtRow[] {
  const geometry = hudGeometry(size, parts);
  const canvas = createCanvas(size.width, size.height, grain);
  const labels: Label[] = [];
  const { rail } = geometry;
  fill(
    canvas,
    { height: 2, width: size.width - rail, x: rail, y: size.height * 2 - 2 },
    hud.grain[1]
  );
  labels.push(
    ...etch(canvas, { height: size.height, x: 0, y: 0 }, "▏", hud.iron[6]),
    ...etch(
      canvas,
      { height: size.height, x: size.width - 1, y: 0 },
      "▕",
      hud.iron[0]
    ),
    ...etch(
      canvas,
      { height: size.height, x: rail - 1, y: 0 },
      "▕",
      hud.iron[0]
    ),
    ...etch(canvas, { height: size.height, x: rail, y: 0 }, "▎", hud.brass[2]),
    ...etch(canvas, { width: rail - 1, x: 0, y: 0 }, "▔", hud.iron[6])
  );
  for (const [index, frame] of geometry.parts.entries()) {
    sink(canvas, labels, frame.inset);
    notch(labels, frame.inset, 1);
    header(canvas, labels, frame, parts[index] ?? {}, geometry.dense);
  }
  if (geometry.steps.x - rail >= 3) {
    for (const x of [rail + 1, size.width - 3]) {
      rivet(canvas, labels, x, 0);
      rivet(canvas, labels, x, geometry.slot.y);
    }
  }
  sink(canvas, labels, geometry.screen);
  notch(labels, geometry.screen, 2);
  goalBar(canvas, labels, geometry.slot);
  return rasterize(canvas, labels);
}
