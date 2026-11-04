/** Anything that must finish before the process exits. */
export interface QuitCleanup {
  shutdown(): Promise<void>;
}

interface QuitEvent {
  preventDefault(): void;
}

/** The slice of Electron's `app` the quit sequence needs. */
export interface QuitHost {
  on(event: "before-quit", listener: (event: QuitEvent) => void): unknown;
  quit(): void;
}

/**
 * Runs `stages` in order, each stage's cleanups together: work is drained
 * before the sandboxes it borrowed and the engine its runs report to are
 * closed. Every stage runs even after a failure; resolves with the failures.
 */
export async function shutdownInStages(
  stages: readonly (readonly QuitCleanup[])[]
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const stage of stages) {
    const results = await Promise.allSettled(
      stage.map((cleanup) => cleanup.shutdown())
    );
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
  }
  return failures;
}

/**
 * Cleanup starts once and the app always quits after it settles, even when a
 * shutdown fails: `stages` run as {@link shutdownInStages} runs them, and
 * each failure is reported. Repeat quit requests during cleanup are cancelled and
 * wait for the same cleanup; the quit that cleanup itself issues goes
 * through.
 */
export function registerQuitCleanup(
  host: QuitHost,
  stages: readonly (readonly QuitCleanup[])[],
  report: (reason: unknown) => void
): void {
  let state: "running" | "cleaning" | "ready" = "running";
  host.on("before-quit", async (event) => {
    if (state === "ready") {
      return;
    }
    event.preventDefault();
    if (state === "cleaning") {
      return;
    }
    state = "cleaning";
    try {
      for (const failure of await shutdownInStages(stages)) {
        report(failure);
      }
    } finally {
      state = "ready";
      host.quit();
    }
  });
}
