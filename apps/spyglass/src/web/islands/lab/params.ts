/**
 * Parameters: a schema each experiment declares once, from which the
 * settings type, the defaults and the sidebar controls follow, and a
 * layout that sorts its controls into titled sections. The vocabulary
 * only: the lab's live store is param-store.ts. Framework-free, so an
 * experiment folder can move anywhere that has this file.
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
  /** Shown after the value: "°", "ms". */
  unit?: string;
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

/**
 * One section of a parameters panel: a title over its params, in the order
 * listed. An array keeps its order where an object's keys are sorted, so the
 * layout, not the schema, decides what the panel shows and in what order.
 */
export interface ParamGroup<Key extends string = string> {
  /** One line under the title: what the section's params share. */
  hint?: string;
  keys: readonly Key[];
  title: string;
}

/** A section of this schema's panel: only its own params' names. */
export type ParamGroupOf<S extends ParamSchema> = ParamGroup<keyof S & string>;

/**
 * What is wrong with a layout: params it leaves out, lists twice, or names
 * that the schema does not hold. Empty when every param appears exactly once.
 */
export function layoutProblems(
  params: ParamSchema,
  layout: readonly ParamGroup[]
): string[] {
  const listed = layout.flatMap((group) => group.keys);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const key of listed) {
    if (!Object.hasOwn(params, key)) {
      problems.push(`"${key}" is not a param`);
    } else if (seen.has(key)) {
      problems.push(`"${key}" is listed twice`);
    }
    seen.add(key);
  }
  for (const key of Object.keys(params)) {
    if (!seen.has(key)) {
      problems.push(`"${key}" is in no group`);
    }
  }
  return problems;
}
