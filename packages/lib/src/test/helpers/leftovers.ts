import { startedAt } from "../../process-identity";

/**
 * Stop a process a test started and left, by its pid, only while it is
 * still the one that started at `started`. It may exit between that
 * check and the signal: then it is gone, which is all this was for.
 */
export function stopLeftover(pid: number, started: string): void {
  if (startedAt(pid) === started) {
    signalOwn(pid, "SIGKILL");
  }
}

/** Signal `target`, a process or group of the test's own; one gone already is done. */
export function signalOwn(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}
