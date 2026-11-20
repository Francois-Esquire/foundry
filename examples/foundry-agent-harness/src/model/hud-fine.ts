import {
  type Cells,
  DARK,
  dotted,
  FACE,
  hline,
  LIGHT,
  nicks,
  pit,
  pointed,
  ring,
  rivet,
  type Sheet,
  sheet,
  vline,
  well,
} from "@/model/fine-kit";
import { type HudPart, hudGeometry } from "@/model/hud-art";
import { hud, tones } from "@/model/palette";
import { type ArtRow, fill, rasterizeFine, stamp } from "@/model/pixels";
import type { Size } from "@/model/screen";

const CAP = " >_ ";
const SEND = " ↵ ";
const [INK, , BRASS, BRACKET, SHINE] = hud.brass;

function pediment({ canvas }: Sheet, centre: number, y: number, tall: number) {
  for (let step = 0; step < tall; step += 1) {
    const reach = 2 + step * 2;
    hline(canvas, centre - reach, y + step, reach * 2, LIGHT);
  }
  fill(
    canvas,
    { height: tall > 3 ? 2 : 1, width: 2, x: centre - 1, y: y + tall - 2 },
    hud.amber
  );
}

function plaque(
  { canvas, labels }: Sheet,
  at: { readonly x: number; readonly y: number },
  text: string,
  tall: boolean
) {
  const end = at.x + text.length;
  const inks = { ground: FACE, ink: BRASS };
  if (tall) {
    const top = (at.y - 1) * 3;
    fill(
      canvas,
      { height: 3, width: text.length * 2, x: at.x * 2, y: top },
      BRASS
    );
    hline(canvas, at.x * 2, top, text.length * 2, SHINE);
    stamp(canvas, (at.x - 1) * 2, top, ["..", ".#", "##", "##", "##", ".#"], {
      ".": FACE,
      "#": BRASS,
    });
    stamp(canvas, end * 2, top, ["..", "#.", "##", "##", "##", "#."], {
      ".": FACE,
      "#": BRASS,
    });
  } else {
    pointed(canvas, { x: at.x - 1, y: at.y }, "left", inks);
    pointed(canvas, { x: end, y: at.y }, "right", inks);
  }
  labels.push({
    bg: BRASS,
    bold: true,
    fg: INK,
    text,
    x: at.x,
    y: at.y,
  });
}

function readout(
  { canvas, labels }: Sheet,
  at: { readonly x: number; readonly y: number },
  text: string
) {
  const inks = { ground: FACE, ink: hud.screen };
  pointed(canvas, { x: at.x - 1, y: at.y }, "left", inks);
  pointed(canvas, { x: at.x + text.length, y: at.y }, "right", inks);
  labels.push({ bg: hud.screen, fg: BRACKET, text, ...at });
}

function head(
  art: Sheet,
  frame: { readonly head: Cells; readonly inset: Cells },
  part: HudPart,
  dense: boolean
) {
  const row = frame.head.y + frame.head.height - 1;
  const left = frame.inset.x;
  const right = frame.inset.x + frame.inset.width;
  if (!dense) {
    rivet(art.canvas, 2, frame.head.y * 3 + 3);
    rivet(art.canvas, (frame.head.width - 2) * 2, frame.head.y * 3 + 3);
  }
  if (!part.title) {
    const tall = frame.head.height * 3;
    pediment(
      art,
      left + right,
      frame.head.y * 3 + (dense ? 1 : 2),
      tall - (dense ? 1 : 2)
    );
    return;
  }
  const title = ` ${part.title} `;
  plaque(art, { x: left + 2, y: row }, title, !dense);
  if (part.meta) {
    const meta = ` ${part.meta} `;
    readout(art, { x: right - 2 - meta.length, y: row }, meta);
  }
}

function brackets({ canvas }: Sheet, area: Cells) {
  const left = area.x * 2;
  const right = (area.x + area.width) * 2 - 1;
  const top = area.y * 3;
  const bottom = (area.y + area.height) * 3 - 1;
  for (const [x, dx] of [
    [left, 1],
    [right, -1],
  ] as const) {
    for (const [y, dy] of [
      [top, 1],
      [bottom, -1],
    ] as const) {
      const armX = dx > 0 ? x + 1 : x - 3;
      const armY = dy > 0 ? y + 1 : y - 4;
      hline(canvas, armX, y + dy, 3, BRACKET);
      vline(canvas, x + dx, armY, 4, BRACKET);
    }
  }
}

function goalBar({ canvas, labels }: Sheet, slot: Cells) {
  const inner = {
    ...slot,
    width: slot.width - CAP.length,
    x: slot.x + CAP.length,
  };
  well(canvas, inner, hud.screen);
  vline(canvas, (slot.x + slot.width) * 2, slot.y * 3, 3, LIGHT);
  hline(canvas, slot.x * 2, (slot.y + 1) * 3, slot.width * 2, LIGHT);
  pointed(canvas, { x: inner.x, y: slot.y }, "right", {
    ground: hud.screen,
    ink: BRASS,
  });
  pointed(
    canvas,
    { x: slot.x + slot.width - SEND.length - 1, y: slot.y },
    "left",
    {
      ground: hud.screen,
      ink: tones.amber.deep,
    }
  );
  labels.push(
    {
      bg: BRASS,
      bold: true,
      fg: INK,
      text: CAP,
      x: slot.x,
      y: slot.y,
    },
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

export function fineHud(size: Size, parts: readonly HudPart[]): Sheet {
  const geometry = hudGeometry(size, parts);
  const art = sheet(size.width, size.height);
  const { canvas } = art;
  const { dense, rail, screen } = geometry;
  const wide = size.width * 2;
  const tall = size.height * 3;
  hline(canvas, 0, 0, rail * 2 - 2, LIGHT);
  hline(canvas, rail * 2 + 2, 0, wide - rail * 2 - 4, LIGHT);
  vline(canvas, 0, 0, tall, LIGHT);
  if (!dense) {
    dotted(canvas, { height: tall, width: 1, x: 1, y: 0 }, LIGHT);
  }
  vline(canvas, wide - 1, 0, tall, DARK);
  vline(canvas, rail * 2 - 1, 0, tall, DARK);
  vline(canvas, rail * 2, 0, tall, BRASS);
  for (const [index, frame] of geometry.parts.entries()) {
    const part = parts[index] ?? {};
    well(canvas, frame.inset, hud.screen);
    ring(canvas, frame.inset, !dense && Boolean(part.title));
    nicks(canvas, frame.inset);
    head(art, frame, part, dense);
  }
  if (geometry.steps.x - rail >= 3) {
    for (const x of [rail * 2 + 2, wide - 6]) {
      rivet(canvas, x, 3);
      rivet(canvas, x, geometry.slot.y * 3);
    }
  }
  well(canvas, screen, hud.screen);
  ring(canvas, screen, false);
  brackets(art, screen);
  goalBar(art, geometry.slot);
  pit(canvas);
  return art;
}

export function fineHudArt(size: Size, parts: readonly HudPart[]): ArtRow[] {
  const { canvas, labels } = fineHud(size, parts);
  return rasterizeFine(canvas, labels);
}
