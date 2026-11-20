export const WEEKDAYS = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export interface CalendarSlot {
  readonly hour: number;
  readonly minute?: number;
  readonly weekday?: Weekday | readonly Weekday[];
}

export type Trigger =
  | { readonly kind: "interval"; readonly ms: number }
  | { readonly kind: "calendar"; readonly slot: CalendarSlot };

export interface Schedule {
  readonly input: unknown;
  readonly key: string;
  readonly kind: "schedule" | "monitor";
  readonly label: string;
  readonly registeredAt?: number;
  readonly trigger: Trigger;
  readonly workflow: string;
}
