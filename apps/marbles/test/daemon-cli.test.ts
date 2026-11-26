import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { daemonAlive } from "~/process/client";
import { cliArgs } from "./helpers/cli";
import { testHome } from "./helpers/home";
import { temporaryDirectory } from "./helpers/temporary";

it("starts, unhosts with --workspace, and stops the Marbles process under marbles start/stop", async () => {
  const home = testHome();
  const root = await realpath(temporaryDirectory("marbles-daemon-cli-"));
  const source = join(root, "marbles.ts");
  writeFileSync(source, 'import "@foundry.sh/marbles";\n');
  const marbles = (...args: string[]) =>
    spawnSync("bun", cliArgs(...args, "--source", source), {
      cwd: root,
      encoding: "utf8",
      env: home.env,
      input: "",
      timeout: 60_000,
    });

  const started = marbles("start");
  expect(started.status, started.stderr).toBe(0);
  expect(started.stdout).toContain(`hosts ${root}`);
  expect(daemonAlive(home.layout)).toBe(true);
  expect(marbles("status").stdout).toContain(root);

  const detached = marbles("stop", "--workspace");
  expect(detached.status, detached.stderr).toBe(0);
  expect(detached.stdout).toContain(`detached ${root}`);
  expect(daemonAlive(home.layout)).toBe(true);

  const stopped = marbles("stop");
  expect(stopped.status, stopped.stderr).toBe(0);
  expect(stopped.stdout).toContain("stopped Marbles process pid");
  expect(daemonAlive(home.layout)).toBe(false);
  expect(marbles("stop").stdout).toContain("no Marbles process is running");

  for (const [removed, hint] of [
    ["daemon", "marbles start or marbles stop"],
    ["attach", "marbles start"],
    ["detach", "marbles stop --workspace"],
  ] as const) {
    const refused = marbles(removed);
    expect(refused.status, removed).toBe(1);
    expect(refused.stderr).toContain(
      `unknown command "${removed}"; ${removed} is now ${hint}`
    );
  }
}, 120_000);
