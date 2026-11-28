import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { providerInstalled } from "~/providers/installed";

it("resolves an adapter without evaluating it and returns false when absent", () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-adapter-resolution-"));
  try {
    const adapter = join(root, "adapter.cjs");
    writeFileSync(
      adapter,
      'throw new Error("must not execute during discovery");'
    );
    expect(providerInstalled(adapter)).toBe(true);
    expect(providerInstalled("ai-sdk-provider-codex-cli")).toBe(true);
    expect(providerInstalled(join(root, "missing.cjs"))).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
