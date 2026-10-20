/** What a step of idle work is given: the browser's deadline, or a timer's. */
interface Deadline {
  didTimeout: boolean;
  timeRemaining(): number;
}

/** One step's budget when no deadline is given: a timer's, or a timed-out idle callback's. */
const stepBudgetMs = 8;
/** How long the work may wait for an idle period before it runs anyway. */
const idleTimeoutMs = 60;

/**
 * Runs the steps of an iterator in the browser's idle time, as many per
 * period as its deadline allows, and calls `done` after the last. Where
 * `requestIdleCallback` is missing the steps run on a timer in budgeted
 * turns. Returns a cancel, which stops the work and never calls `done`.
 */
export function runIdle(
  steps: Iterator<unknown>,
  done: () => void
): () => void {
  const idle =
    typeof requestIdleCallback === "function" &&
    typeof cancelIdleCallback === "function";
  let cancelled = false;
  let handle = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = (deadline: Deadline) => {
    const started = performance.now();
    const remaining = () =>
      deadline.didTimeout
        ? started + stepBudgetMs - performance.now()
        : deadline.timeRemaining();
    do {
      if (steps.next().done) {
        done();
        return;
      }
    } while (!cancelled && remaining() > 0);
    if (!cancelled) {
      schedule();
    }
  };
  const schedule = () => {
    if (idle) {
      handle = requestIdleCallback(step, { timeout: idleTimeoutMs });
      return;
    }
    timer = setTimeout(() => {
      step({ didTimeout: true, timeRemaining: () => 0 });
    }, 0);
  };
  schedule();
  return () => {
    cancelled = true;
    if (idle) {
      cancelIdleCallback(handle);
    } else {
      clearTimeout(timer);
    }
  };
}
