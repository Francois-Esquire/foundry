export class ModuleRuntimeCleanupError extends Error {
  readonly cleanup: () => Promise<void>;

  constructor(cleanup: () => Promise<void>, options: ErrorOptions) {
    super("Module runtime cleanup is incomplete", options);
    this.cleanup = cleanup;
    this.name = "ModuleRuntimeCleanupError";
  }
}

export async function rethrowAfterCleanup(
  error: unknown,
  cleanup: () => Promise<void>,
  message: string
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    // biome-ignore lint/style/useErrorCause: The cause is an AggregateError holding both the original failure and `cleanupError`, so the owner sees each.
    throw new ModuleRuntimeCleanupError(cleanup, {
      cause: new AggregateError([error, cleanupError], message, {
        cause: error,
      }),
    });
  }
  throw error;
}
