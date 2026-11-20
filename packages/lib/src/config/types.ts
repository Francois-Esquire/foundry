// biome-ignore lint/suspicious/noEmptyInterface: Consumers extend this interface through declaration merging.
export interface ConfigShape {}

export type Path<T = ConfigShape> = T extends object
  ? {
      [K in keyof T & string]:
        | K
        | (NonNullable<T[K]> extends object
            ? `${K}.${Path<NonNullable<T[K]>>}`
            : never);
    }[keyof T & string]
  : never;

export type ValueAt<
  T,
  P extends string,
> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? NonNullable<T[Head]> extends object
      ? ValueAt<NonNullable<T[Head]>, Rest>
      : unknown
    : unknown
  : P extends keyof T
    ? T[P]
    : unknown;

export type Prefix = keyof ConfigShape & string;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object | undefined
    ? DeepPartial<NonNullable<T[K]>> | undefined
    : T[K];
};

export type ChangeSource = "set" | "merge" | "reset" | "load";

export interface ConfigChangePayload<TBefore = unknown, TAfter = unknown> {
  after: TAfter;
  before: TBefore;
  path: string;
  source: ChangeSource;
}

export interface LoadedPayload {
  applied: readonly string[];
}

export interface CredentialsChangePayload<T> {
  after: Readonly<T>;
  before: Readonly<T>;
}
