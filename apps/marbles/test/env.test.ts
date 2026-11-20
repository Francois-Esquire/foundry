import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executionEnvironment } from "~/lib/environment";
import { EnvironmentError, loadEnvironment } from "~/workspace/env";

const REQUIRED_PATTERN = /MARBLES_TEST_TOKEN is required/;
const INSTALL_PATTERN =
  /needs Varlock to load; install it with `bun add -d varlock`/;
const STOPPED_PATTERN =
  /^\[env\] .* Varlock ran longer than 0\.2s and was stopped$/;
const STOPPED_TWO_SECONDS = /Varlock ran longer than 2s and was stopped$/;
const NOT_JSON_PATTERN =
  /^\[env\] .* Varlock printed something other than a JSON object$/;

let root: string;
const saved = { ...process.env };
const strays: number[] = [];

function killed(pid: number): boolean {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return true;
}

function childOf(dir: string): number {
  const path = join(dir, "child.pid");
  expect(existsSync(path)).toBe(true);
  const pid = Number(readFileSync(path, "utf8").trim());
  strays.push(pid);
  return pid;
}

const CHILD = 'sleep 30 &\necho $! > "$PWD/child.pid"\n';

function fakeVarlock(dir: string): void {
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "varlock");
  writeFileSync(
    script,
    `#!/bin/sh
if [ -n "$MARBLES_TEST_TOKEN" ]; then
  printf '{"MARBLES_TEST_TOKEN":"%s","MARBLES_TEST_GREETING":"hello"}' "$MARBLES_TEST_TOKEN"
else
  echo "MARBLES_TEST_TOKEN is required but is currently empty"
  exit 1
fi
`
  );
  chmodSync(script, 0o755);
}

function fakeScript(dir: string, body: string): void {
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "varlock");
  writeFileSync(script, `#!/bin/sh\n${body}`);
  chmodSync(script, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marbles-env-"));
});

afterEach(() => {
  for (const pid of strays.splice(0)) {
    killed(pid);
  }
  for (const name of Object.keys(process.env)) {
    if (!(name in saved)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, saved);
  rmSync(root, { force: true, recursive: true });
});

describe("loadEnvironment", () => {
  it("changes nothing without a schema", () => {
    const lines: string[] = [];
    loadEnvironment(root, "require", (line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it("puts what the schema resolves under what the machine already set, for the workspace's commands alone", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    fakeVarlock(root);
    process.env.MARBLES_TEST_TOKEN = "from-shell";
    process.env.MARBLES_TEST_GREETING = "kept";
    expect(
      executionEnvironment(loadEnvironment(root, "require", () => undefined))
    ).toMatchObject({
      MARBLES_TEST_GREETING: "kept",
      MARBLES_TEST_TOKEN: "from-shell",
    });

    delete process.env.MARBLES_TEST_GREETING;
    expect(
      executionEnvironment(loadEnvironment(root, "require", () => undefined))
        .MARBLES_TEST_GREETING
    ).toBe("hello");
    expect(process.env).not.toHaveProperty("MARBLES_TEST_GREETING");
  });

  it("returns the environment before the merge and what the schema resolved", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    fakeVarlock(root);
    process.env.MARBLES_TEST_TOKEN = "from-shell";
    delete process.env.MARBLES_TEST_GREETING;
    const environment = loadEnvironment(root, "require", () => undefined);
    expect(environment.workspace).toEqual({
      MARBLES_TEST_GREETING: "hello",
      MARBLES_TEST_TOKEN: "from-shell",
    });
    expect(environment.machine.MARBLES_TEST_TOKEN).toBe("from-shell");
    expect(environment.machine).not.toHaveProperty("MARBLES_TEST_GREETING");
    expect(process.env).not.toHaveProperty("MARBLES_TEST_GREETING");
  });

  it("reads what Varlock prints from a file it writes, never a pipe it could lose", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const script = join(bin, "varlock");
    writeFileSync(
      script,
      `#!/bin/sh
if [ ! -f /dev/stdout ]; then
  exit 0
fi
printf '{"MARBLES_TEST_TOKEN":"from a file"}'
`
    );
    chmodSync(script, 0o755);
    expect(loadEnvironment(root, "require", () => undefined).workspace).toEqual(
      { MARBLES_TEST_TOKEN: "from a file" }
    );
  });

  it("returns no workspace values without a schema or when one only warns", () => {
    expect(loadEnvironment(root, "require", () => undefined).workspace).toEqual(
      {}
    );
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    fakeVarlock(root);
    delete process.env.MARBLES_TEST_TOKEN;
    expect(loadEnvironment(root, "warn", () => undefined).workspace).toEqual(
      {}
    );
  });

  it("fails work about to run, and only warns otherwise, when a value is missing", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    fakeVarlock(root);
    delete process.env.MARBLES_TEST_TOKEN;
    expect(() => loadEnvironment(root, "require", () => undefined)).toThrow(
      REQUIRED_PATTERN
    );
    expect(() => loadEnvironment(root, "require", () => undefined)).toThrow(
      EnvironmentError
    );
    const lines: string[] = [];
    loadEnvironment(root, "warn", (line) => lines.push(line));
    expect(lines[0]).toMatch(REQUIRED_PATTERN);
    expect(lines[0]?.startsWith("[env] ")).toBe(true);
  });

  it("stops a Varlock that does not exit, failing work about to run and only warning otherwise", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    fakeScript(root, "trap '' TERM\nexec sleep 30\n");
    const started = Date.now();
    expect(() =>
      loadEnvironment(root, "require", () => undefined, 200)
    ).toThrow(EnvironmentError);
    const lines: string[] = [];
    expect(
      loadEnvironment(root, "warn", (line) => lines.push(line), 200).workspace
    ).toEqual({});
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(lines).toEqual([expect.stringMatching(STOPPED_PATTERN)]);
  });

  it("stops what a Varlock that does not exit started, once it reports the stop", async () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    fakeScript(root, `${CHILD}sleep 30\n`);
    expect(() =>
      loadEnvironment(root, "require", () => undefined, 2000)
    ).toThrow(STOPPED_TWO_SECONDS);
    expect(await goneWithin(childOf(root), 5000)).toBe(true);
  }, 15_000);

  it("leaves what a Varlock that exits started alone", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    fakeScript(root, `${CHILD}printf '{"MARBLES_TEST_TOKEN":"kept"}'\n`);
    expect(
      loadEnvironment(root, "require", () => undefined, 2000).workspace
    ).toEqual({ MARBLES_TEST_TOKEN: "kept" });
    expect(alive(childOf(root))).toBe(true);
  });

  it("fails work about to run, and only warns otherwise, when Varlock prints something other than a JSON object", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    for (const printed of ["not json", "[1]", "null"]) {
      fakeScript(root, `printf '%s' '${printed}'\n`);
      expect(() => loadEnvironment(root, "require", () => undefined)).toThrow(
        EnvironmentError
      );
      const lines: string[] = [];
      loadEnvironment(root, "warn", (line) => lines.push(line));
      expect(lines).toEqual([expect.stringMatching(NOT_JSON_PATTERN)]);
    }
  });

  it("names the install command when Varlock is not there", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    process.env.PATH = "";
    expect(() => loadEnvironment(root, "require", () => undefined)).toThrow(
      INSTALL_PATTERN
    );
  });
});
