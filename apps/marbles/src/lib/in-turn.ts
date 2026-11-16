/**
 * Run `first`, then `then` whatever `first` did, and report every
 * failure: one alone as it is, both together as one `AggregateError`.
 * A close that fails after a dispose that failed never hides it.
 */
export async function inTurn(
  first: () => Promise<void>,
  then: () => Promise<void> | void,
  message: string
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await first();
  } catch (error) {
    errors.push(error);
  }
  try {
    await then();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, message);
  }
}
