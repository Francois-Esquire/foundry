import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { install, launchdPlan, uninstall } from "~/launchd";
import type { Schedule, Trigger } from "~/lib/registry";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true });
  }
});

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "quirks-home-"));
  homes.push(home);
  return home;
}

const schedule: Schedule = {
  input: "hey",
  name: "twice-hourly",
  trigger: { kind: "interval", ms: 3_600_000 },
  workflow: "twice",
};

const options = {
  config: "/repo/quirks.config.ts",
  cwd: "/repo",
  home: "/home",
  path: "/usr/bin",
  state: "/repo/.quirks",
};

const planWith = (trigger: Trigger) =>
  launchdPlan({ ...schedule, trigger }, options).plist;

describe("launchdPlan", () => {
  it("names the label and plist after the schedule", () => {
    const home = fakeHome();
    const plan = launchdPlan(schedule, {
      config: "/repo/quirks.config.ts",
      cwd: "/repo",
      home,
      path: "/usr/bin",
      state: "/repo/.quirks",
    });
    expect(plan.label).toBe("com.foundry.quirks.twice-hourly");
    expect(plan.plistPath).toBe(
      join(home, "Library/LaunchAgents/com.foundry.quirks.twice-hourly.plist")
    );
    expect(plan.plist).toContain("<string>once</string>");
    expect(plan.plist).toContain("<string>twice-hourly</string>");
    expect(plan.plist).toContain("<string>/repo/quirks.config.ts</string>");
    expect(plan.plist).toContain("<string>/repo/.quirks</string>");
    expect(plan.plist).toContain("<integer>3600</integer>");
    expect(plan.plist).toContain("<string>/repo</string>");
    expect(plan.plist).toContain(
      `<string>${join(home, "Library/Logs/quirks/twice-hourly.log")}</string>`
    );
    expect(plan.plist).toContain("<false/>");
  });

  it("escapes XML in values", () => {
    const plan = launchdPlan(schedule, {
      config: "/repo/quirks.config.ts",
      cwd: "/repo",
      home: fakeHome(),
      path: "/usr/bin:/opt/a&b/bin",
      state: "/repo/.quirks",
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
    expect(existsSync(join(home, "Library/Logs/quirks"))).toBe(true);
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
});
