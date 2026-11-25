import { startedAt } from "../../node/process-identity";

export function stopLeftover(pid: number, started: string): void {
  if (startedAt(pid) === started) {
    signalOwn(pid, "SIGKILL");
  }
}

export function signalOwn(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}
