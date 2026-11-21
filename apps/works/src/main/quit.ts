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

export interface QuitWindow {
  close(): void;
  isDestroyed(): boolean;
  off(event: "closed", listener: () => void): unknown;
  once(event: "closed", listener: () => void): unknown;
}

export class QuitWindows<W extends QuitWindow> {
  readonly #closing = new Map<W, () => void>();

  kept(window: W): void {
    this.#closing.get(window)?.();
  }

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
