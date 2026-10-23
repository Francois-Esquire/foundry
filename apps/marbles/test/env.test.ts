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
import { EnvironmentError, loadEnvironment } from "~/workspace/env";

const REQUIRED_PATTERN = /MARBLES_TEST_TOKEN is required/;
const INSTALL_PATTERN =
  /needs Varlock to load; install it with `bun add -d varlock`/;

let root: string;
const saved = { ...process.env };

/** A stand-in `varlock` in the workspace: JSON when the token is set, else Varlock's complaint. */
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

  it("merges what the schema resolves under what is already set", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    fakeVarlock(root);
    process.env.MARBLES_TEST_TOKEN = "from-shell";
    process.env.MARBLES_TEST_GREETING = "kept";
    loadEnvironment(root, "require", () => undefined);
    expect(process.env.MARBLES_TEST_TOKEN).toBe("from-shell");
    expect(process.env.MARBLES_TEST_GREETING).toBe("kept");

    delete process.env.MARBLES_TEST_GREETING;
    loadEnvironment(root, "require", () => undefined);
    expect(process.env.MARBLES_TEST_GREETING).toBe("hello");
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

  it("names the install command when Varlock is not there", () => {
    writeFileSync(join(root, ".env.schema"), "MARBLES_TEST_TOKEN=\n");
    process.env.PATH = "";
    expect(() => loadEnvironment(root, "require", () => undefined)).toThrow(
      INSTALL_PATTERN
    );
  });
});
