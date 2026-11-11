import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ModuleCheckoutError } from "../node/checkouts";
import { createModuleSelectedCheckouts } from "../node/selected-checkouts";
import { publishedModule } from "./helpers/published-module";

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "foundry-selected-"));
  directories.push(root);
  const module = await publishedModule();
  const checkouts = createModuleSelectedCheckouts({
    artifacts: module.artifacts,
    checkoutPath: (moduleId) => path.join(root, moduleId, "artifact"),
  });
  const folder = path.join(root, module.moduleId);
  return {
    ...module,
    checkout: path.join(folder, "artifact"),
    checkouts,
    folder,
    root,
  };
}

const SERVER = "outputs/packages/server/dist/index.js";

async function server(checkout: string) {
  return await readFile(path.join(checkout, SERVER), "utf8");
}

/** Staged or set-aside copies left beside the checkout. */
async function scratch(folder: string) {
  return (await readdir(folder)).filter((name) => name.startsWith("."));
}

describe("Module selected checkouts", () => {
  it("swaps the selected Version's outputs in read-only, then records", async () => {
    const { checkout, checkouts, folder, publish } = await fixture();
    const v1 = await publish("1.0.0");
    const v2 = await publish("2.0.0");
    expect(await checkouts.select(v1, () => Promise.resolve("one"))).toBe(
      "one"
    );
    expect(await server(checkout)).toBe('export const tag = "1.0.0";');
    // biome-ignore lint/suspicious/noBitwiseOperators: Mode bits are a bitmask.
    expect((await stat(path.join(checkout, SERVER))).mode & 0o222).toBe(0);

    let during = "";
    await checkouts.select(v2, async () => {
      during = await server(checkout);
    });
    // The new files are in place before the selection is recorded.
    expect(during).toBe('export const tag = "2.0.0";');
    expect(await readdir(checkout)).toEqual(["outputs"]);
    expect(await scratch(folder)).toEqual([]);
  });

  it("puts the previous files back when the record fails", async () => {
    const { checkout, checkouts, folder, publish } = await fixture();
    const v1 = await publish("1.0.0");
    const v2 = await publish("2.0.0");
    await checkouts.select(v1, () => Promise.resolve());
    await expect(
      checkouts.select(v2, () => Promise.reject(new Error("record failed")))
    ).rejects.toThrow("record failed");
    expect(await server(checkout)).toBe('export const tag = "1.0.0";');
    expect(await scratch(folder)).toEqual([]);
  });

  it("re-projects an interrupted swap or tampered files from the selection", async () => {
    const { checkout, checkouts, folder, publish } = await fixture();
    const v1 = await publish("1.0.0");
    const v2 = await publish("2.0.0");
    await checkouts.ensure({ version: v1 });

    // Interrupted after moving the old files aside, before placing new ones.
    await rename(checkout, path.join(folder, ".artifact-aside"));
    await mkdir(path.join(folder, ".artifact-staging"));
    expect((await checkouts.ensure({ version: v1 })).hostPath).toBe(checkout);
    expect(await server(checkout)).toBe('export const tag = "1.0.0";');
    expect(await scratch(folder)).toEqual([]);

    // Another Version's files, as an unrecorded switch would leave them.
    await checkouts.select(v2, () => Promise.resolve());
    await checkouts.ensure({ version: v1 });
    expect(await server(checkout)).toBe('export const tag = "1.0.0";');

    await chmod(path.join(checkout, SERVER), 0o644);
    await writeFile(path.join(checkout, SERVER), "tampered");
    await checkouts.ensure({ version: v1 });
    expect(await server(checkout)).toBe('export const tag = "1.0.0";');
  });

  it("refuses a Version whose stored Content does not match it", async () => {
    const { checkouts, folder, publish } = await fixture();
    const v1 = await publish("1.0.0");
    await expect(
      checkouts.select({ ...v1, digest: "0".repeat(64) }, () =>
        Promise.resolve()
      )
    ).rejects.toThrow(ModuleCheckoutError);
    await expect(readdir(folder)).rejects.toThrow();
  });
});
