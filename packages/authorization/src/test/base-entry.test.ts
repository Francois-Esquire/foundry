import { resolve } from "node:path";
import {
  assertExportLayout,
  assertExportNames,
  assertPackageTiers,
  assertWebStandardExports,
  portableSubpaths,
} from "@foundry/lib/testing/seam";
import { describe, expect, it } from "vitest";
import { Authorization, Permit } from "../index";
import { MemoryAuthorizationStore } from "../store/memory";

const PACKAGE_DIR = resolve(import.meta.dirname, "../..");
const PACKAGES_DIR = resolve(PACKAGE_DIR, "..");

describe("@foundry/authorization base entry and seams", () => {
  it("evaluates and runs Authorization over MemoryAuthorizationStore without Node adapters", async () => {
    const auth = new Authorization({ store: new MemoryAuthorizationStore() });
    const decision = await auth.check({
      action: "file.read",
      principal: { id: "agent-1", kind: "agent" },
      target: "/workspace/README.md",
    });
    expect(decision.kind).toBe("ask");
    expect(await auth.listGrants()).toEqual([]);
    expect(await auth.listRestrictions()).toEqual([]);
  });

  it("refuses direct construction of Permit", () => {
    const fakeToken = Symbol("fake");
    expect(
      () =>
        new Permit(
          fakeToken,
          {
            grantId: "grt_1" as never,
            grantPath: [],
            invocationId: "inv_1",
            issuedAt: 0,
          },
          new AbortController().signal,
          () => undefined
        )
    ).toThrow(TypeError);
  });

  it("passes Web-standard, layout, naming, and package tier seam audits", () => {
    const subpaths = portableSubpaths(PACKAGE_DIR);
    expect(subpaths).toEqual(
      expect.arrayContaining([
        ".",
        "./store",
        "./store/memory",
        "./testing/store",
      ])
    );
    expect(() => assertWebStandardExports(PACKAGE_DIR, subpaths)).not.toThrow();
    expect(() => assertExportLayout(PACKAGES_DIR)).not.toThrow();
    expect(() => assertExportNames(PACKAGES_DIR)).not.toThrow();
    expect(() => assertPackageTiers(PACKAGES_DIR)).not.toThrow();
  });
});
