import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { install, launchdPlan, preview, uninstall } from "~/launchd";
import type { Schedule, Trigger } from "~/lib/triggers";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true });
  }
});

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "marbles-home-"));
  homes.push(home);
  return home;
}

const schedule: Schedule = {
  input: "hey",
  key: "twice-hourly",
  kind: "schedule",
  label: "twice hourly",
  trigger: { kind: "interval", ms: 3_600_000 },
  workflow: "twice",
};

const options = {
  artifacts: "/repo/artifacts",
  config: "/repo/marbles.config.ts",
  cwd: "/repo",
  home: "/home",
  only: [],
  path: "/usr/bin",
  state: "/repo/.marbles",
};

const planWith = (trigger: Trigger) =>
  launchdPlan({ ...schedule, trigger }, options).plist;

describe("launchdPlan", () => {
  it("names the label and plist after the schedule", () => {
    const home = fakeHome();
    const plan = launchdPlan(schedule, { ...options, home });
    expect(plan.label).toBe("com.foundry.marbles.twice-hourly");
    expect(plan.plistPath).toBe(
      join(home, "Library/LaunchAgents/com.foundry.marbles.twice-hourly.plist")
    );
    expect(plan.plist).toContain("<string>roll</string>");
    expect(plan.plist).toContain("<string>twice-hourly</string>");
    expect(plan.plist).toContain("<string>/repo/marbles.config.ts</string>");
    expect(plan.plist).toContain("<string>/repo/.marbles</string>");
    expect(plan.plist).toContain("<integer>3600</integer>");
    expect(plan.plist).toContain("<string>/repo</string>");
    expect(plan.plist).toContain(
      `<string>${join(home, "Library/Logs/marbles/twice-hourly.log")}</string>`
    );
    expect(plan.plist).toContain("<false/>");
  });

  it("carries the artifact store and harness selection into the run", () => {
    const { plist } = launchdPlan(schedule, {
      ...options,
      only: ["codex", "claude-code"],
    });
    expect(plist).toContain(`    <string>--state</string>
    <string>/repo/.marbles</string>
    <string>--artifacts</string>
    <string>/repo/artifacts</string>
    <string>--harness</string>
    <string>codex</string>
    <string>--harness</string>
    <string>claude-code</string>
  </array>`);
  });

  it("escapes XML in values", () => {
    const plan = launchdPlan(schedule, {
      ...options,
      home: fakeHome(),
      path: "/usr/bin:/opt/a&b/bin",
    });
    expect(plan.plist).toContain("<string>/usr/bin:/opt/a&amp;b/bin</string>");
    expect(plan.plist).not.toContain("a&b");
  });

  it("writes a daily slot as one StartCalendarInterval dict", () => {
    const plist = planWith({ kind: "calendar", slot: { hour: 2 } });
    expect(plist).not.toContain("StartInterval");
    expect(plist).toContain(`  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>`);
  });

  it("writes weekdays as an array of dicts, Sunday = 0", () => {
    const plist = planWith({
      kind: "calendar",
      slot: { hour: 9, minute: 30, weekday: ["sun", "fri"] },
    });
    expect(plist).toContain(`  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Weekday</key>
      <integer>0</integer>
      <key>Hour</key>
      <integer>9</integer>
      <key>Minute</key>
      <integer>30</integer>
    </dict>
    <dict>
      <key>Weekday</key>
      <integer>5</integer>
      <key>Hour</key>
      <integer>9</integer>
      <key>Minute</key>
      <integer>30</integer>
    </dict>
  </array>`);
  });
});

describe("install / uninstall", () => {
  const domain = `gui/${String(process.getuid?.() ?? 0)}`;

  it("writes and loads, then unloads and removes, through launchctl", () => {
    const home = fakeHome();
    const lines: string[] = [];
    const calls: string[][] = [];
    const run = (args: readonly string[]) => {
      calls.push([...args]);
      // A fresh label is not loaded yet, so the first bootout fails.
      if (calls.length === 1) {
        throw new Error("not loaded");
      }
    };
    const plan = launchdPlan(schedule, { ...options, home });

    install(plan, (line) => lines.push(line), run);
    expect(readFileSync(plan.plistPath, "utf8")).toBe(plan.plist);
    expect(existsSync(join(home, "Library/Logs/marbles"))).toBe(true);
    expect(calls).toEqual([
      ["bootout", `${domain}/${plan.label}`],
      ["bootstrap", domain, plan.plistPath],
    ]);
    expect(lines).toContain(`[launchd] loaded ${plan.label}`);

    uninstall(plan, (line) => lines.push(line), run);
    expect(existsSync(plan.plistPath)).toBe(false);
    expect(calls[2]).toEqual(["bootout", `${domain}/${plan.label}`]);
    expect(lines).toContain(`[launchd] unloaded ${plan.label}`);
  });

  it("prints the manual command when launchctl fails", () => {
    const home = fakeHome();
    const lines: string[] = [];
    const plan = launchdPlan(schedule, { ...options, home });
    const failing = () => {
      throw Object.assign(new Error("exit 1"), {
        stderr: "Bootstrap failed: 5",
      });
    };

    install(plan, (line) => lines.push(line), failing);
    expect(existsSync(plan.plistPath)).toBe(true);
    expect(lines).toContain("[launchd] load failed: Bootstrap failed: 5");
    expect(lines).toContain(`launchctl bootstrap ${domain} ${plan.plistPath}`);

    uninstall(plan, (line) => lines.push(line), failing);
    expect(existsSync(plan.plistPath)).toBe(false);
    expect(lines).toContain(`launchctl bootout ${domain}/${plan.label}`);
  });

  it("previews without writing or calling launchctl", () => {
    const home = fakeHome();
    const lines: string[] = [];
    const plan = launchdPlan(schedule, { ...options, home });

    preview("install", plan, (line) => lines.push(line));
    expect(lines).toEqual([
      `[launchd] would write ${plan.plistPath}`,
      plan.plist.trimEnd(),
      `launchctl bootout ${domain}/${plan.label}`,
      `launchctl bootstrap ${domain} ${plan.plistPath}`,
    ]);
    expect(existsSync(join(home, "Library"))).toBe(false);

    lines.length = 0;
    preview("uninstall", plan, (line) => lines.push(line));
    expect(lines).toEqual([
      `launchctl bootout ${domain}/${plan.label}`,
      `[launchd] would remove ${plan.plistPath}`,
    ]);
  });
});

describe("marbles launchd --dry-run", () => {
  it("prints the plan with the run's flags and installs nothing", () => {
    const root = fakeHome();
    const source = join(root, ".foundry", "marbles");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "ping.ts"),
      `import { schedule, step } from "@foundry/marbles";
schedule(step("ping").do(() => 1)).every("1h");`
    );
    const home = join(root, "home");
    const argv = [
      resolve("src/cli.ts"),
      "launchd",
      "install",
      "ping",
      "--dry-run",
      "--harness",
      "codex",
      "--artifacts",
      join(root, "feed"),
      "--state",
      join(root, "state"),
    ];
    const run = () =>
      execFileSync("bun", argv, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
    if (process.platform !== "darwin") {
      expect(run).toThrow("macOS only");
      return;
    }
    const output = run();
    expect(output).toContain(
      `[launchd] would write ${join(home, "Library/LaunchAgents/com.foundry.marbles.ping.plist")}`
    );
    expect(output).toContain(`<string>--artifacts</string>
    <string>${join(root, "feed")}</string>
    <string>--harness</string>
    <string>codex</string>`);
    // Bun writes its own cache under ~/Library, so check the launchd paths.
    expect(existsSync(join(home, "Library/LaunchAgents"))).toBe(false);
    expect(existsSync(join(home, "Library/Logs"))).toBe(false);
    expect(existsSync(join(root, "state"))).toBe(false);
  });
});
