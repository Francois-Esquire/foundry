import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * The processes a test run can prove it started: those whose environment
 * holds a marker the run set, `NAME=value`. Pid reuse cannot fake an
 * environment, so a marker is proof where a pid and start time are not.
 * A marked process that leads its own process group (a detached daemon, a
 * CLI on a terminal) is stopped with its whole group, which reaches the
 * children it started without the marker (a worker, an MCP server given
 * a bare environment); any other marked process is stopped alone, since
 * its group is someone else's.
 */
export interface MarkedProcess {
  readonly pgid: number;
  readonly pid: number;
}

export interface StopLimits {
  /** How long the processes get to exit after SIGTERM. */
  readonly graceMs: number;
  /** How long after SIGKILL before a survivor is reported. */
  readonly killMs: number;
}

const LIMITS: StopLimits = { graceMs: 5000, killMs: 2000 };
const POLL_MS = 50;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s(.*)$/;
const PID = /^\d+$/;

/** Every other process whose environment holds exactly `name=value`. */
export function markedProcesses(name: string, value: string): MarkedProcess[] {
  const marker = `${name}=${value}`;
  const found =
    process.platform === "linux" ? fromProc(marker) : fromPs(marker);
  return found.filter(({ pid }) => pid !== process.pid);
}

/**
 * SIGTERM each process (its group when it leads one), wait, SIGKILL what
 * is left, wait again. Resolves with the pids still running after that,
 * empty when every one is confirmed gone.
 */
export async function stopProcesses(
  processes: readonly MarkedProcess[],
  limits: StopLimits = LIMITS
): Promise<number[]> {
  const targets = new Map(
    processes.map((marked) => [
      marked.pid,
      marked.pgid === marked.pid ? -marked.pid : marked.pid,
    ])
  );
  let left = [...targets.keys()].filter((pid) =>
    signal(targets.get(pid) ?? pid, "SIGTERM")
  );
  left = await waitGone(left, targets, limits.graceMs);
  left = left.filter((pid) => signal(targets.get(pid) ?? pid, "SIGKILL"));
  return await waitGone(left, targets, limits.killMs);
}

async function waitGone(
  pids: readonly number[],
  targets: ReadonlyMap<number, number>,
  ms: number
): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = pids.filter((pid) => signal(targets.get(pid) ?? pid, 0));
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    left = left.filter((pid) => signal(targets.get(pid) ?? pid, 0));
  }
  return left;
}

/**
 * Send `sig` to `target` (a pid, or a negated group id); whether it is
 * still there. A group whose members have exited but are not yet reaped
 * answers EPERM on macOS, which counts as still there.
 */
function signal(target: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * macOS: `ps -E` appends each process's initial environment to its
 * command line, space-separated. The marker must be a whole word there.
 */
function fromPs(marker: string): MarkedProcess[] {
  const listed = spawnSync("ps", ["-axwwE", "-o", "pid=,pgid=,command="], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(`ps failed: ${listed.stderr}`);
  }
  const found: MarkedProcess[] = [];
  for (const line of listed.stdout.split("\n")) {
    const parsed = PS_LINE.exec(line);
    const words = parsed?.[3]?.split(" ") ?? [];
    if (parsed && words.includes(marker)) {
      found.push({ pgid: Number(parsed[2]), pid: Number(parsed[1]) });
    }
  }
  return found;
}

/** Linux: each process's initial environment, NUL-separated, in /proc. */
function fromProc(marker: string): MarkedProcess[] {
  const found: MarkedProcess[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!PID.test(entry)) {
      continue;
    }
    try {
      const environment = readFileSync(`/proc/${entry}/environ`, "utf8");
      if (environment.split("\0").includes(marker)) {
        // The fifth field of `stat`, counted after the command's closing paren.
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const pgid = Number(
          stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]
        );
        found.push({ pgid, pid: Number(entry) });
      }
    } catch {
      // Gone, or not ours to read: not proven, so not listed.
    }
  }
  return found;
}
