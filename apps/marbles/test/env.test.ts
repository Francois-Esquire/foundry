import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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
const NOT_JSON_PATTERN =
  /^\[env\] .* Varlock printed something other than a JSON object$/;

let root: string;
const saved = { ...process.env };

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
