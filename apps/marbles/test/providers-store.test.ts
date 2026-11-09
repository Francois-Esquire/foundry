import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readProvidersFile,
  updateProvidersFile,
  updateProvidersFiles,
} from "~/lib/providers/store";
import { acquireLock } from "~/lib/state/locks";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marbles-providers-"));
  path = join(dir, "providers.json");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const entry = (id: string) => ({ enabled: true, id, plugin: "codex" });

it("tells a missing file from an unreadable one", () => {
  expect(readProvidersFile(path)).toBeUndefined();
  writeFileSync(path, "{ not json");
  expect(() => readProvidersFile(path)).toThrow(
    expect.objectContaining({ code: "CONFIGURATION_UNREADABLE" })
  );
  writeFileSync(path, JSON.stringify({ providers: "no", version: 1 }));
  expect(() => readProvidersFile(path)).toThrow(
    expect.objectContaining({ code: "CONFIGURATION_UNREADABLE" })
  );
});

it("writes atomically, readable by its owner only, and re-reads before each edit", async () => {
  await updateProvidersFile(path, dir, () => ({
    providers: [entry("a")],
    version: 1,
  }));
  expect((statSync(path).mode % 0o1000).toString(8)).toBe("600");
  await Promise.all([
    updateProvidersFile(path, dir, (current) => ({
      providers: [...(current?.providers ?? []), entry("b")],
      version: 1,
    })),
    updateProvidersFile(path, dir, (current) => ({
      providers: [...(current?.providers ?? []), entry("c")],
      version: 1,
    })),
  ]);
  expect(
    readProvidersFile(path)
      ?.providers.map((provider) => provider.id)
      .sort()
  ).toEqual(["a", "b", "c"]);
});

it("writes nothing when the edit refuses, and never overwrites an unreadable file", async () => {
  await expect(
    updateProvidersFile(path, dir, () => {
      throw new Error("refused");
    })
  ).rejects.toThrow("refused");
  expect(readProvidersFile(path)).toBeUndefined();
  writeFileSync(path, "{ not json");
  await expect(
    updateProvidersFile(path, dir, () => ({ providers: [], version: 1 }))
  ).rejects.toMatchObject({ code: "CONFIGURATION_UNREADABLE" });
});

it("fails busy when another holder keeps the lock", async () => {
  const held = acquireLock(dir, "providers");
  try {
    await expect(
      updateProvidersFile(path, dir, () => ({ providers: [], version: 1 }))
    ).rejects.toMatchObject({ code: "CONFIGURATION_BUSY" });
  } finally {
    if ("release" in held) {
      held.release();
    }
  }
});

it("never quotes a file's contents when it cannot be read", () => {
  const secret = "skPASTEDSECRET123";
  writeFileSync(
    path,
    `{ "providers": [{ "settings": { "key": ${secret} } }] }`
  );
  expect(() => readProvidersFile(path)).toThrow("is not valid JSON");
  expect(() => readProvidersFile(path)).toThrow(
    expect.objectContaining({
      message: expect.not.stringContaining("PASTED"),
    })
  );
  for (const misplaced of [
    { providers: [], version: secret },
    { providers: [{ enabled: secret, id: "x", plugin: "codex" }], version: 1 },
    { providers: secret, version: 1 },
  ]) {
    writeFileSync(path, JSON.stringify(misplaced));
    expect(() => readProvidersFile(path)).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("PASTED"),
      })
    );
    expect(() => readProvidersFile(path)).toThrow(
      "cannot be read as provider configuration"
    );
  }
});

it("puts back every file already written when a later write fails", async () => {
  const other = join(dir, "other");
  const locked = join(dir, "readonly");
  mkdirSync(other);
  mkdirSync(locked);
  writeFileSync(
    path,
    JSON.stringify({ providers: [entry("kept")], version: 1 })
  );
  const before = readFileSync(path, "utf8");
  const fresh = join(other, "providers.json");
  chmodSync(locked, 0o500);
  try {
    await expect(
      updateProvidersFiles([
        {
          edit: () => ({ providers: [entry("new")], version: 1 }),
          lockDir: dir,
          path,
        },
        {
          edit: () => ({ providers: [entry("new")], version: 1 }),
          lockDir: other,
          path: fresh,
        },
        {
          edit: () => ({ providers: [entry("new")], version: 1 }),
          lockDir: join(dir, "locks-3"),
          path: join(locked, "providers.json"),
        },
      ])
    ).rejects.toThrow();
  } finally {
    chmodSync(locked, 0o700);
  }
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(existsSync(fresh)).toBe(false);
});
