import { grain } from "@/model/grain";
import { hud, tones } from "@/model/palette";
import {
  type ArtRow,
  createCanvas,
  etch,
  fill,
  type Label,
  rasterize,
} from "@/model/pixels";

type StepState = "active" | "done" | "pending";

export interface Step {
  readonly label: string;
  readonly state: StepState;
}

export interface StepChip {
  readonly state: StepState;
  readonly text: string;
}

export const STEP_LINK = 2;
const VENT = "▎▎▎▎▎▎▎";
const MARKS = { active: "▶ ", done: "✓ ", pending: "" } as const;
export const STEP_FACES = {
  active: {
    face: tones.amber.lit,
    ink: hud.brass[0],
    lower: tones.amber.dim,
    upper: tones.amber.glow,
  },
  done: {
    face: tones.green.deep,
    ink: hud.ok,
    lower: hud.iron[0],
    upper: tones.green.dim,
  },
  pending: {
    face: hud.iron[1],
    ink: hud.dim,
    lower: hud.iron[5],
    upper: hud.iron[0],
  },
} as const;

function chip(step: Step, index: number, full: boolean): StepChip {
  const name = full ? ` ${step.label}` : "";
  return {
    state: step.state,
    text: ` ${MARKS[step.state]}${index + 1}${name} `,
  };
}

function span(chips: readonly StepChip[]): number {
  return (
    chips.reduce((sum, item) => sum + item.text.length, 0) +
    Math.max(chips.length - 1, 0) * STEP_LINK
  );
}

export function fitSteps(steps: readonly Step[], width: number): StepChip[] {
  const tiers: ((step: Step) => boolean)[] = [
    () => true,
    (step) => step.state !== "done",
    (step) => step.state === "active",
  ];
  for (const full of tiers) {
    const chips = steps.map((step, index) => chip(step, index, full(step)));
    if (span(chips) <= width) {
      return chips;
    }
  }
  return steps.map((step, index) => chip(step, index, false));
}

export function stepStripArt(steps: readonly Step[], width: number): ArtRow[] {
  const canvas = createCanvas(width, 3, grain);
  const labels: Label[] = etch(canvas, { width, x: 0, y: 0 }, "▔", hud.iron[6]);
  let x = 1;
  for (const [index, item] of fitSteps(steps, width - 2).entries()) {
    const look = STEP_FACES[item.state];
    const size = item.text.length;
    if (index > 0) {
      fill(
        canvas,
        { height: 1, width: STEP_LINK, x: x - STEP_LINK, y: 2 },
        hud.iron[0]
      );
      fill(
        canvas,
        { height: 1, width: STEP_LINK, x: x - STEP_LINK, y: 3 },
        hud.iron[5]
      );
    }
    labels.push(
      {
        bg: canvas[0]?.[x] ?? look.face,
        fg: look.upper,
        text: "▄".repeat(size),
        x,
        y: 0,
      },
      {
        bg: canvas[4]?.[x] ?? look.face,
        fg: look.lower,
        text: "▀".repeat(size),
        x,
        y: 2,
      },
      {
        bg: look.face,
        bold: item.state === "active",
        fg: look.ink,
        text: item.text,
        x,
        y: 1,
      }
    );
    x += size + STEP_LINK;
  }
  const ventX = width - VENT.length - 2;
  if (ventX > x) {
    fill(
      canvas,
      { height: 2, width: VENT.length, x: ventX, y: 2 },
      hud.iron[0]
    );
    labels.push(
      ...etch(
        canvas,
        { width: VENT.length, x: ventX, y: 1 },
        "▎",
        tones.amber.lit
      )
    );
  }
  return rasterize(canvas, labels);
}
