/**
 * `T` when `Output` and `T` are assignable to each other, otherwise `never`.
 *
 * Pins a runtime schema to a hand-written type: annotate the schema constant
 * as `ZodType<Exactly<z.infer<typeof schema>, T>>` and it stops typechecking
 * when either side gains a required member, loses a member the other
 * requires, or changes a member's type.
 *
 * Mutual assignability is weaker than equality. It does not catch an
 * optional member present on only one side (a strict schema would then
 * accept a key the type never declares), and it ignores `readonly`, which is
 * what lets a mutable schema output pin a readonly type.
 */
export type Exactly<Output, T> = [Output] extends [T]
  ? [T] extends [Output]
    ? T
    : never
  : never;
