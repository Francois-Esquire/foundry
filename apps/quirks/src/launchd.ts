import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Schedule, Trigger, Weekday } from "~/lib/registry";

import { weekdays } from "~/schedule";

interface PlistOptions {
  readonly label: string;
  /** Receives both stdout and stderr. */
  readonly log: string;
  readonly path: string;
  readonly program: readonly string[];
  readonly trigger: Trigger;
  readonly workingDirectory: string;
}

export interface LaunchdPlan {
  readonly label: string;
  readonly log: string;
  readonly plist: string;
  readonly plistPath: string;
}

export interface PlanOptions {
  readonly config: string;
  readonly cwd: string;
  readonly home: string;
  readonly path: string;
  readonly state: string;
}

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const WEEKDAY_NUMBER: Record<Weekday, number> = {
  fri: 5,
  mon: 1,
  sat: 6,
  sun: 0,
  thu: 4,
  tue: 2,
  wed: 3,
};

function calendarDict(fields: Record<string, number>, indent: string): string {
  const entries = Object.entries(fields)
    .map(
      ([key, value]) =>
        `${indent}  <key>${key}</key>\n${indent}  <integer>${String(value)}</integer>`
    )
    .join("\n");
  return `${indent}<dict>\n${entries}\n${indent}</dict>`;
}

/** `StartInterval` in seconds, or `StartCalendarInterval`: one dict daily, one per weekday otherwise. */
function triggerKeys(trigger: Trigger): string {
  if (trigger.kind === "interval") {
    return `  <key>StartInterval</key>
  <integer>${String(trigger.ms / 1000)}</integer>`;
  }
  const { slot } = trigger;
  const time = { Hour: slot.hour, Minute: slot.minute ?? 0 };
  const days = weekdays(slot);
  const value =
    days.length === 0
      ? calendarDict(time, "  ")
      : `  <array>\n${days
          .map((day) =>
            calendarDict({ Weekday: WEEKDAY_NUMBER[day], ...time }, "    ")
          )
          .join("\n")}\n  </array>`;
  return `  <key>StartCalendarInterval</key>\n${value}`;
}

function plistFor(options: PlistOptions): string {
  const program = options.program
    .map((arg) => `    <string>${escape(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${program}
  </array>
${triggerKeys(options.trigger)}
  <key>RunAtLoad</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>${escape(options.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(options.path)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escape(options.log)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(options.log)}</string>
</dict>
</plist>
`;
}

export function launchdPlan(
  schedule: Schedule,
  options: PlanOptions
): LaunchdPlan {
  const label = `com.foundry.quirks.${schedule.name}`;
  // The CLI that is running now, whether that is src/cli.ts or dist/cli.js.
  const cli = resolve(process.argv[1] ?? "");
  const log = join(
    options.home,
    "Library",
    "Logs",
    "quirks",
    `${schedule.name}.log`
  );
  const plist = plistFor({
    label,
    log,
    path: options.path,
    program: [
      process.execPath,
      cli,
      "once",
      schedule.name,
      "--config",
      options.config,
      "--state",
      options.state,
    ],
    trigger: schedule.trigger,
    workingDirectory: options.cwd,
  });
  return {
    label,
    log,
    plist,
    plistPath: join(options.home, "Library", "LaunchAgents", `${label}.plist`),
  };
}

/** Runs `launchctl <args>`; throws with its stderr when it exits non-zero. */
export type Launchctl = (args: readonly string[]) => void;

const launchctl: Launchctl = (args) => {
  execFileSync("launchctl", args, { stdio: ["ignore", "ignore", "pipe"] });
};

const domain = () => `gui/${String(process.getuid?.() ?? 0)}`;

/**
 * Writes the plist and loads it. A stale registration is booted out first:
 * `bootstrap` refuses a label that is already loaded, so reinstall after a
 * config change would otherwise fail. If `launchctl` itself fails the manual
 * command is printed instead.
 */
export function install(
  plan: LaunchdPlan,
  print: (line: string) => void,
  run: Launchctl = launchctl
): void {
  mkdirSync(dirname(plan.plistPath), { recursive: true });
  mkdirSync(dirname(plan.log), { recursive: true });
  try {
    run(["bootout", `${domain()}/${plan.label}`]);
  } catch {
    // Not loaded; nothing to boot out.
  }
  writeFileSync(plan.plistPath, plan.plist);
  print(`[launchd] wrote ${plan.plistPath}`);
  const args = ["bootstrap", domain(), plan.plistPath];
  try {
    run(args);
    print(`[launchd] loaded ${plan.label}`);
  } catch (error) {
    print(`[launchd] load failed: ${message(error)}`);
    print(`launchctl ${args.join(" ")}`);
  }
}

/** Unloads by label, so it still works once the plist is gone, then removes the file. */
export function uninstall(
  plan: LaunchdPlan,
  print: (line: string) => void,
  run: Launchctl = launchctl
): void {
  const args = ["bootout", `${domain()}/${plan.label}`];
  try {
    run(args);
    print(`[launchd] unloaded ${plan.label}`);
  } catch (error) {
    print(`[launchd] unload failed: ${message(error)}`);
    print(`launchctl ${args.join(" ")}`);
  }
  rmSync(plan.plistPath, { force: true });
  print(`[launchd] removed ${plan.plistPath}`);
}

function message(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    const stderr = String(error.stderr).trim();
    if (stderr !== "") {
      return stderr;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
