import { chmod, lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nodeFileSystem } from "../node";
import { makeRoot } from "./helpers/temp-roots";

/**
 * Kept apart from the other save tests because the module mock below is
 * hoisted over the whole file.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, chmod: vi.fn(original.chmod) };
});

describe("nodeFileSystem.replaceFile permissions", () => {
  it("applies the existing permission bits through the open handle, not by path", async () => {
    const root = await makeRoot({ "mode.txt": "before" });
    const target = join(root, "mode.txt");
    await chmod(target, 0o640);
    vi.mocked(chmod).mockClear();

    await nodeFileSystem.replaceFile(target, new TextEncoder().encode("after"));

    expect(chmod).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("after");
    // biome-ignore lint/suspicious/noBitwiseOperators: Filesystem permissions are a bit mask.
    expect((await lstat(target)).mode & 0o7777).toBe(0o640);
    expect(await readdir(root)).toEqual(["mode.txt"]);
  });
});
