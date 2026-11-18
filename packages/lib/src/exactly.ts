export type Exactly<Output, T> = [Output] extends [T]
  ? [T] extends [Output]
    ? T
    : never
  : never;
