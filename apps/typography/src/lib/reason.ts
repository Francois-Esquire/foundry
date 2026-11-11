/** Why something failed, as the thrown value says it. */
export const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
