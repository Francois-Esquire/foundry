import { describe, expect, it } from "vitest";
import {
  buildModuleSdkGeneratorSource,
  emitModuleSdk,
} from "../../scripts/emit-sdk";
import { buildModuleSdkPack } from "../sdk";
import { MODULE_SDK_EMITTED } from "../sdk/emitted.generated";
import { MODULE_SDK_GENERATOR_ENTRYPOINT } from "../sdk/generator-entrypoint.generated";

describe("Module SDK emitted artifacts", () => {
  it("matches a fresh compile of the authored source", () => {
    expect(MODULE_SDK_GENERATOR_ENTRYPOINT).toBe(
      buildModuleSdkGeneratorSource()
    );
    expect({ ...MODULE_SDK_EMITTED }).toEqual({ ...emitModuleSdk() });
  });

  it("serves the emitted artifacts as the pack's dist", async () => {
    const pack = await buildModuleSdkPack();
    expect(pack.files["dist/index.js"]).toBe(MODULE_SDK_EMITTED.esm);
    expect(pack.files["dist/generate.js"]).toBe(
      MODULE_SDK_EMITTED.generatorEsm
    );
  });
});
