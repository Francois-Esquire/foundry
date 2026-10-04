/**
 * What a trigger is, as data. A schedule is known by its target and input,
 * a monitor by its source; the key names the state files, the launchd label,
 * and `once <key>`.
 */

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

/** A wall-clock slot in machine-local time; no `weekday` means every day. */
export interface CalendarSlot {
  readonly hour: number;
  /** Defaults to 0. */
  readonly minute?: number;
  readonly weekday?: Weekday | readonly Weekday[];
}

export type Trigger =
  | { readonly kind: "interval"; readonly ms: number }
  | { readonly kind: "calendar"; readonly slot: CalendarSlot };

export interface Schedule {
  readonly input: unknown;
  /** Safe in a filename, a launchd label, and argv. */
  readonly key: string;
  readonly kind: "schedule" | "monitor";
  /** For people: the target and its input, or the monitored source. */
  readonly label: string;
  /** Durable creation time seeds the first deadline before any tick history exists. */
  readonly registeredAt?: number;
  readonly trigger: Trigger;
  /** The launchable definition's name. */
  readonly workflow: string;
}
