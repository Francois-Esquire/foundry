/**
 * `T` when `Output` and `T` are assignable to each other, otherwise `never`.
 *
 * Pins a runtime schema to a hand-written type: annotate the schema constant
 * as `ZodType<Exactly<z.infer<typeof schema>, T>>` and it stops typechecking
 * the moment either side gains, loses, or changes a member. (Assignability
 * ignores `readonly`, so a mutable schema output can pin a readonly type.)
 */
export type Exactly<Output, T> = [Output] extends [T]
  ? [T] extends [Output]
    ? T
    : never
  : never;
