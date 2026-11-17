import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RUNTIME_FLAGS, runtime } from "~/process/runtime";

let workspace: string;
let scripts: string;

/** A script that prints what Bun loaded from the workspace's `.env`, if anything. */
function probe(shebang: string): string {
  const path = join(scripts, `probe-${Math.random().toString(36).slice(2)}`);
  writeFileSync(
    path,
    `${shebang}\nconsole.log(process.env.MARBLES_DOTENV_PROBE ?? "absent");\n`
  );
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "marbles-dotenv-"));
  scripts = mkdtempSync(join(tmpdir(), "marbles-probe-"));
  writeFileSync(join(workspace, ".env"), "MARBLES_DOTENV_PROBE=from-dotenv\n");
});

afterEach(() => {
  rmSync(workspace, { force: true, recursive: true });
  rmSync(scripts, { force: true, recursive: true });
});

it("would load a workspace .env without the flags", () => {
  const ran = spawnSync(runtime(), [probe("")], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(ran.stdout.trim()).toBe("from-dotenv");
});

it("spawns Marbles processes without loading the workspace .env", () => {
  const ran = spawnSync(runtime(), [...RUNTIME_FLAGS, probe("")], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(ran.stdout.trim()).toBe("absent");
});

it("starts the installed CLI through its bin without loading the workspace .env", () => {
  const pkg = join(scripts, "node_modules", "@foundry.sh", "marbles");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "dist"));
  copyFileSync(resolve("bin/marbles"), join(pkg, "bin", "marbles"));
  chmodSync(join(pkg, "bin", "marbles"), 0o755);
  writeFileSync(
    join(pkg, "dist", "cli.js"),
    "console.log(JSON.stringify([process.env.MARBLES_DOTENV_PROBE ?? null, process.env.MARBLES_SHELL_PROBE ?? null, process.execArgv, process.argv.slice(2)]));\n"
  );
  const bin = join(scripts, "node_modules", ".bin");
  mkdirSync(bin);
  symlinkSync("../@foundry.sh/marbles/bin/marbles", join(bin, "marbles"));
  writeFileSync(
    join(workspace, ".env"),
    "MARBLES_DOTENV_PROBE=from-dotenv\nMARBLES_SHELL_PROBE=from-dotenv\n"
  );

  const ran = spawnSync(join(bin, "marbles"), ["run", "two words"], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      MARBLES_SHELL_PROBE: "from-shell",
      PATH: join(process.execPath, ".."),
    },
  });

  expect(JSON.parse(ran.stdout)).toEqual([
    null,
    "from-shell",
    ["--no-env-file"],
    ["run", "two words"],
  ]);
});

it("refuses to start the CLI when Bun loaded a workspace .env, and starts with the flag", () => {
  const cli = resolve("src/cli.ts");
  const bare = spawnSync(runtime(), [cli, "--help"], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(bare.status).toBe(1);
  expect(bare.stderr).toContain("Bun loaded .env from");

  const flagged = spawnSync(runtime(), [...RUNTIME_FLAGS, cli, "--help"], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(flagged.status).toBe(0);
  expect(flagged.stdout).toContain("programmable workspace automation");
}, 30_000);

it("refuses the MCP server when Bun loaded a workspace .env, and starts it as documented", () => {
  const cli = resolve("src/cli.ts");
  const bare = spawnSync(runtime(), [cli, "mcp", "--help"], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(bare.status).toBe(1);
  expect(bare.stderr).toContain("Bun loaded .env from");

  const flagged = spawnSync(
    runtime(),
    [...RUNTIME_FLAGS, cli, "mcp", "--help"],
    { cwd: workspace, encoding: "utf8" }
  );
  expect(flagged.status).toBe(0);
  expect(flagged.stdout).toContain("mcp   ");
}, 30_000);

it("refuses a worker started without the flag beside a workspace .env", () => {
  const ran = spawnSync(runtime(), [resolve("src/process/worker.ts")], {
    cwd: workspace,
    encoding: "utf8",
  });
  expect(ran.status).toBe(1);
  expect(ran.stderr).toContain("Bun loaded .env from");
}, 30_000);
