export interface QuitCleanup {
  shutdown(): Promise<void>;
}

interface QuitEvent {
  preventDefault(): void;
}

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

/** A window a quit closes first: Electron's `BrowserWindow`. */
export interface QuitWindow {
  close(): void;
  isDestroyed(): boolean;
  off(event: "closed", listener: () => void): unknown;
  once(event: "closed", listener: () => void): unknown;
}

/**
 * Closes windows for a quit, before any cleanup: a window whose page holds
 * unsaved work asks first, and choosing to keep editing keeps it open.
 */
export class QuitWindows<W extends QuitWindow> {
  readonly #closing = new Map<W, () => void>();

  /** The person kept `window` open: its close for the quit is cancelled. */
  kept(window: W): void {
    this.#closing.get(window)?.();
  }

  /** Close each window in turn: false once one stays open, else true. */
  async close(windows: readonly W[]): Promise<boolean> {
    for (const window of windows) {
      if (!(await this.#close(window))) {
        return false;
      }
    }
    return true;
  }

  #close(window: W): Promise<boolean> {
    if (window.isDestroyed()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const settle = (closed: boolean) => {
        window.off("closed", onClosed);
        this.#closing.delete(window);
        resolve(closed);
      };
      const onClosed = () => settle(true);
      window.once("closed", onClosed);
      this.#closing.set(window, () => settle(false));
      window.close();
    });
  }
}

/**
 * A quit first asks `confirm` (closing the windows, whose unsaved work may
 * keep one open); only a confirmed quit starts cleanup, so declining leaves
 * every service running and the next quit asks again. Cleanup starts once
 * and the app always quits after it settles, even when a shutdown fails:
 * `stages` run as {@link shutdownInStages} runs them, and each failure is
 * reported. Repeat quit requests while confirming or cleaning are
 * cancelled and wait for the same quit; the quit cleanup itself issues
 * goes through.
 */
export function registerQuitCleanup(
  host: QuitHost,
  stages: readonly (readonly QuitCleanup[])[],
  report: (reason: unknown) => void,
  confirm: () => Promise<boolean> = () => Promise.resolve(true)
): void {
  let state: "running" | "confirming" | "cleaning" | "ready" = "running";
  host.on("before-quit", async (event) => {
    if (state === "ready") {
      return;
    }
    event.preventDefault();
    if (state !== "running") {
      return;
    }
    state = "confirming";
    let confirmed = false;
    try {
      confirmed = await confirm();
    } catch (error) {
      report(error);
    }
    if (!confirmed) {
      state = "running";
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
