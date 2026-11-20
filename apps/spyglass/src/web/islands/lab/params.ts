interface ParamBase {
  hint?: string;
  label?: string;
}

export interface NumberParam extends ParamBase {
  kind: "number";
  max: number;
  min: number;
  step: number;
  unit?: string;
  value: number;
}

export interface SelectParam<T extends string = string> extends ParamBase {
  kind: "select";
  labels?: Partial<Record<T, string>>;
  options: readonly T[];
  value: T;
}

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

export interface ParamGroup<Key extends string = string> {
  hint?: string;
  keys: readonly Key[];
  title: string;
}

export type ParamGroupOf<S extends ParamSchema> = ParamGroup<keyof S & string>;

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
