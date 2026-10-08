import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openModuleLibrary } from "~/main/modules/library";
import {
  moduleDirectory,
  openLocalModuleLibrary,
} from "~/main/modules/local-library";
import { buildResult } from "../helpers/module-build";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "works-local-modules-"));
  roots.push(root);
  const { library } = await openLocalModuleLibrary(root);
  const module = await library.create("Local app");
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("Source missing");
  }
  return {
    details,
    expected: details.binding,
    folder: path.join(root, moduleDirectory(module.id)),
    library,
    module,
    root,
  };
}
it("stores an ordinary workspace on disk and reopens saved source", async () => {
  const { root, library, module, folder, details, expected } = await fixture();
  expect(
    await readFile(path.join(folder, "packages/app/src/App.tsx"), "utf8")
  ).toContain("Local app");
  const source = {
    ...details.source,
    "packages/app/src/App.tsx": "saved edit",
  };
  await library.saveSource(module.id, source, expected);
  expect(
    await readFile(path.join(folder, "packages/app/src/App.tsx"), "utf8")
  ).toBe("saved edit");
  expect(
    (await (await openLocalModuleLibrary(root)).library.details(module.id))
      ?.source
  ).toEqual(source);
});
it("captures external edits and rejects a stale editor save", async () => {
  const { library, module, folder, details, expected } = await fixture();
  await writeFile(
    path.join(folder, "packages/app/src/App.tsx"),
    "external edit"
  );
  await expect(
    library.saveSource(module.id, details.source, expected)
  ).rejects.toThrow();
  expect(
    (await library.details(module.id))?.source["packages/app/src/App.tsx"]
  ).toBe("external edit");
  expect(
    await readFile(path.join(folder, "packages/app/src/App.tsx"), "utf8")
  ).toBe("external edit");
});
it("preserves ignored local files while updating authored source", async () => {
  const { library, module, folder, details, expected } = await fixture();
  await writeFile(path.join(folder, ".env.local"), "LOCAL_SETTING=kept");
  await library.saveSource(
    module.id,
    { ...details.source, "README.md": "updated" },
    expected
  );
  expect(await readFile(path.join(folder, ".env.local"), "utf8")).toBe(
    "LOCAL_SETTING=kept"
  );
  expect(
    (await library.details(module.id))?.source[".env.local"]
  ).toBeUndefined();
});
it("prevents publication over an external edit made during compilation", async () => {
  const { library, module, folder, details, expected } = await fixture();
  await writeFile(path.join(folder, "README.md"), "edited while building");
  await expect(
    library.publish(module.id, expected, {
      ...buildResult(details.source),
      tag: "0.1.0",
    })
  ).rejects.toThrow("changed during the build");
  expect((await library.details(module.id))?.releases).toEqual([]);
  expect(await readFile(path.join(folder, "README.md"), "utf8")).toBe(
    "edited while building"
  );
});
it("migrates the existing Works library without deleting the original", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "works-migration-"));
  roots.push(root);
  const legacy = path.join(root, "legacy-profile");
  const original = openModuleLibrary(legacy);
  const module = await original.create("Existing app");
  const destination = path.join(root, "foundry/modules");
  const migrated = await openLocalModuleLibrary(destination, legacy);
  expect((await migrated.library.list())[0]?.id).toBe(module.id);
  expect(
    await readFile(
      path.join(
        destination,
        moduleDirectory(module.id),
        "packages/app/src/App.tsx"
      ),
      "utf8"
    )
  ).toContain("Existing app");
  expect(await original.list()).toHaveLength(1);
  expect(moduleDirectory("../../outside")).not.toContain("/");
});

it("does not create or write source through a workspace symlink", async () => {
  const { root, library, module, folder, details, expected } = await fixture();
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(folder, "linked"), "dir");
  await expect(
    library.saveSource(
      module.id,
      { ...details.source, "linked/new/file.ts": "must not escape" },
      expected
    )
  ).rejects.toThrow("unsupported symlink");
  await expect(
    readFile(path.join(outside, "new/file.ts"))
  ).rejects.toMatchObject({ code: "ENOENT" });
});
