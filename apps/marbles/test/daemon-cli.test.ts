import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { daemonAlive } from "~/process/client";
import { cliArgs } from "./helpers/cli";
import { testHome } from "./helpers/home";
import { temporaryDirectory } from "./helpers/temporary";

it("starts, attaches, detaches and stops the Marbles process under marbles daemon", async () => {
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

  const foreground = spawn("bun", cliArgs("daemon", "start"), {
    cwd: root,
    env: home.env,
  });
  home.track(foreground.pid, false);
  const exited = new Promise<number | null>((settle) =>
    foreground.on("exit", settle)
  );
  await vi.waitFor(() => expect(daemonAlive(home.layout)).toBe(true), {
    interval: 100,
    timeout: 30_000,
  });

  const attached = marbles("daemon", "attach");
  expect(attached.status, attached.stderr).toBe(0);
  expect(attached.stdout).toContain(`hosts ${root}`);
  expect(marbles("status").stdout).toContain(root);

  const detached = marbles("daemon", "detach");
  expect(detached.status, detached.stderr).toBe(0);
  expect(detached.stdout).toContain(`detached ${root}`);

  const stopped = marbles("daemon", "stop");
  expect(stopped.status, stopped.stderr).toBe(0);
  expect(stopped.stdout).toContain("stopped Marbles process pid");
  expect(await exited).not.toBeNull();
  expect(daemonAlive(home.layout)).toBe(false);
  expect(marbles("daemon", "stop").stdout).toContain(
    "no Marbles process is running"
  );

  for (const removed of ["attach", "detach", "stop"]) {
    const refused = marbles(removed);
    expect(refused.status, removed).toBe(1);
    expect(refused.stderr).toContain(
      `unknown command "${removed}"; ${removed} is now marbles daemon ${removed}`
    );
  }
}, 120_000);
