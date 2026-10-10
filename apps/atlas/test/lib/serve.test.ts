import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { serve } from "../../src/lib/serve";

// Vitest runs this file on Node, so it sees what a Node importer of the
// library sees: the module loads, and serving needs Bun.
describe("serve outside Bun", () => {
  it("rejects with a message that names Bun", async () => {
    await expect(serve(tmpdir())).rejects.toThrow(
      "Atlas serve needs Bun (>=1.3.14)."
    );
  });

  it("rejects a collection with the same message, before reading anything", async () => {
    await expect(
      serve.collection([tmpdir(), "/nowhere/at/all"])
    ).rejects.toThrow("Atlas serve needs Bun (>=1.3.14).");
  });
});
