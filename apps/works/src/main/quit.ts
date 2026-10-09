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
 * Cleanup starts once and the app always quits after it settles, even when a
 * shutdown fails. Repeat quit requests during cleanup are cancelled and wait
 * for the same cleanup; the quit that cleanup itself issues goes through.
 */
export function registerQuitCleanup(
  host: QuitHost,
  cleanups: readonly QuitCleanup[],
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
      const results = await Promise.allSettled(
        cleanups.map((cleanup) => cleanup.shutdown())
      );
      for (const result of results) {
        if (result.status === "rejected") {
          report(result.reason);
        }
      }
    } finally {
      state = "ready";
      host.quit();
    }
  });
}
