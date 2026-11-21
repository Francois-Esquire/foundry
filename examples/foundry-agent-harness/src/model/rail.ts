import { type Context, EFFORTS, type Effort, slotsOf } from "@/model/context";

export type RailStop = "avatar" | "effort" | "model" | "slot";

export interface Rail {
  readonly avatar: number;
  readonly effort: Effort;
  readonly focus: RailStop;
  readonly model: string;
  readonly slot: number;
}

export function startRail(context: Context): Rail {
  return {
    avatar: 0,
    effort: "medium",
    focus: "model",
    model: context.models[0],
    slot: 0,
  };
}

function wrapped(index: number, by: number, count: number): number {
  return count > 0 ? (((index + by) % count) + count) % count : 0;
}

function clamped(index: number, by: number, count: number): number {
  return Math.min(Math.max(index + by, 0), Math.max(count - 1, 0));
}

export function focusOn(rail: Rail, stops: readonly RailStop[]): RailStop {
  return stops.includes(rail.focus) ? rail.focus : (stops[0] ?? rail.focus);
}

export function refocus(
  rail: Rail,
  stops: readonly RailStop[],
  backwards: boolean
): Rail {
  const at = stops.indexOf(focusOn(rail, stops));
  const focus = stops[wrapped(at, backwards ? -1 : 1, stops.length)];
  return focus ? { ...rail, focus } : rail;
}

export function adjust(
  rail: Rail,
  stops: readonly RailStop[],
  by: number,
  { avatars, context }: { readonly avatars: number; readonly context: Context }
): Rail {
  if (stops.length === 0) {
    return rail;
  }
  const focus = focusOn(rail, stops);
  if (focus === "avatar") {
    return { ...rail, avatar: wrapped(rail.avatar, by, avatars) };
  }
  if (focus === "model") {
    const at = wrapped(
      context.models.indexOf(rail.model),
      by,
      context.models.length
    );
    return { ...rail, model: context.models[at] ?? rail.model };
  }
  if (focus === "effort") {
    const at = clamped(EFFORTS.indexOf(rail.effort), -by, EFFORTS.length);
    return { ...rail, effort: EFFORTS[at] ?? rail.effort };
  }
  return { ...rail, slot: clamped(rail.slot, by, slotsOf(context).length) };
}
