/**
 * Parameters: a schema each experiment declares once, from which the
 * settings type, the defaults, the sidebar controls, and a store the render
 * loop reads every frame all follow. Framework-free, so an experiment folder
 * can move anywhere that has this file.
 */

interface ParamBase {
  /** One line under the control. */
  hint?: string;
  /** Sidebar label; defaults to the key. */
  label?: string;
}

export interface NumberParam extends ParamBase {
  kind: "number";
  max: number;
  min: number;
  step: number;
  value: number;
}

export interface SelectParam<T extends string = string> extends ParamBase {
  kind: "select";
  labels?: Partial<Record<T, string>>;
  options: readonly T[];
  value: T;
}

/** A non-negative integer seed, with a button that rolls a new one. */
export interface SeedParam extends ParamBase {
  kind: "seed";
  value: number;
}

export interface ToggleParam extends ParamBase {
  kind: "toggle";
  value: boolean;
}

export interface ColorParam extends ParamBase {
  kind: "color";
  value: string;
}

export type Param =
  | NumberParam
  | SelectParam
  | SeedParam
  | ToggleParam
  | ColorParam;
export type ParamSchema = Record<string, Param>;

type ValueOf<P extends Param> =
  P extends SelectParam<infer T>
    ? T
    : P extends ColorParam
      ? string
      : P extends ToggleParam
        ? boolean
        : number;

/** The settings object a schema describes: `{ seed: number, view: "a" | "b", … }`. */
export type ParamValues<S extends ParamSchema> = {
  [K in keyof S]: ValueOf<S[K]>;
};

const MAX_SEED = 2 ** 31;
const HEX_COLOR = /^#[\da-f]{6}$/i;

export const param = {
  color: (value: string, extra: ParamBase = {}): ColorParam => ({
    kind: "color",
    value,
    ...extra,
  }),
  number: (options: Omit<NumberParam, "kind">): NumberParam => ({
    kind: "number",
    ...options,
  }),
  seed: (value: number, extra: ParamBase = {}): SeedParam => ({
    kind: "seed",
    value,
    ...extra,
  }),
  select: <const T extends string>(
    options: readonly T[],
    value: NoInfer<T>,
    extra: ParamBase & { labels?: Partial<Record<T, string>> } = {}
  ): SelectParam<T> => ({ kind: "select", options, value, ...extra }),
  toggle: (value: boolean, extra: ParamBase = {}): ToggleParam => ({
    kind: "toggle",
    value,
    ...extra,
  }),
};

export function defineParams<const S extends ParamSchema>(schema: S): S {
  return schema;
}

export function defaultValues<S extends ParamSchema>(
  schema: S
): ParamValues<S> {
  return Object.fromEntries(
    Object.entries(schema).map(([key, spec]) => [key, spec.value])
  ) as ParamValues<S>;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * MAX_SEED);
}

/** Brings a raw control value into the param's range and type. */
function coerce(spec: Param, raw: unknown): ValueOf<Param> {
  switch (spec.kind) {
    case "color":
      return typeof raw === "string" && HEX_COLOR.test(raw)
        ? raw.toLowerCase()
        : spec.value;
    case "number": {
      const value = Number(raw);
      return Number.isFinite(value)
        ? Math.min(spec.max, Math.max(spec.min, value))
        : spec.value;
    }
    case "seed": {
      const value = Math.trunc(Number(raw));
      return Number.isFinite(value) ? Math.abs(value) % MAX_SEED : spec.value;
    }
    case "select":
      return spec.options.includes(String(raw)) ? String(raw) : spec.value;
    case "toggle":
      return Boolean(raw);
    default:
      return spec satisfies never;
  }
}

export interface ParamStore<S extends ParamSchema> {
  /**
   * The current values. Every change replaces the object, so a render loop
   * can compare it by identity to know when to redraw.
   */
  readonly current: ParamValues<S>;
  reset: () => void;
  readonly schema: S;
  set: <K extends keyof S>(key: K, raw: unknown) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createParamStore<S extends ParamSchema>(
  schema: S
): ParamStore<S> {
  let current = defaultValues(schema);
  const listeners = new Set<() => void>();
  const publish = (next: ParamValues<S>) => {
    current = next;
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    get current() {
      return current;
    },
    reset() {
      publish(defaultValues(schema));
    },
    schema,
    set(key, raw) {
      const spec = schema[key];
      // The key's type keeps it within the schema; the guard only narrows the type.
      if (!spec) {
        return;
      }
      const value = coerce(spec, raw);
      if (current[key] !== value) {
        publish({ ...current, [key]: value });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
