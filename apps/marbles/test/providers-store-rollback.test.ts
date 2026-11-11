import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { updateProvidersFiles } from "~/lib/providers/store";

/** Each `fsync` asks this which error, if any, to throw; calls are counted from 1. */
const failing = vi.hoisted(() => ({
  calls: 0,
  error: (_call: number): string | undefined => undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      failing.calls += 1;
      const code = failing.error(failing.calls);
      if (code) {
        throw Object.assign(new Error(`${code}: injected`), { code });
      }
      return fs.fsyncSync(fd);
    },
  };
});

let dir: string;
const file = (name: string) => join(dir, name, "providers.json");
const content = (id: string) =>
  `${JSON.stringify({ providers: [{ enabled: true, id, plugin: "codex" }], version: 1 }, null, 2)}\n`;

function edits() {
  return ["a", "b"].map((name) => ({
    edit: () => ({
      providers: [{ enabled: true, id: "new", plugin: "codex" }],
      version: 1 as const,
    }),
    lockDir: join(dir, name),
    path: file(name),
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marbles-rollback-"));
  for (const name of ["a", "b"]) {
    mkdirSync(join(dir, name));
    writeFileSync(file(name), content(`old-${name}`));
  }
  failing.calls = 0;
  failing.error = () => undefined;
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

// Per file: the temp file's fsync, then the directory's after the rename.
it("puts back a file whose directory sync failed after its rename", async () => {
  failing.error = (call) => (call === 4 ? "EIO" : undefined);
  await expect(updateProvidersFiles(edits())).rejects.toThrow("EIO: injected");
  expect(readFileSync(file("a"), "utf8")).toBe(content("old-a"));
  expect(readFileSync(file("b"), "utf8")).toBe(content("old-b"));
});

it("reports the files it could not put back, keeping the first failure as the cause", async () => {
  failing.error = (call) => (call >= 4 ? "EIO" : undefined);
  const rejection = updateProvidersFiles(edits());
  await expect(rejection).rejects.toMatchObject({
    cause: expect.objectContaining({ message: "EIO: injected" }),
    code: "CONFIGURATION_PARTIAL",
  });
  await expect(rejection).rejects.toThrow(file("a"));
});

it("accepts a filesystem that cannot sync a directory", async () => {
  failing.error = (call) => (call % 2 === 0 ? "EINVAL" : undefined);
  await updateProvidersFiles(edits());
  expect(readFileSync(file("b"), "utf8")).toContain('"new"');
});
