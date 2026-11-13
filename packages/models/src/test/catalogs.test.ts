import { describe, expect, it } from "vitest";

import { modelAudit } from "../audit";
import { modelErrors } from "../errors";

describe("modelErrors catalog", () => {
  it("prefixes every code with `models.`", () => {
    const err = modelErrors.PROVIDER_NOT_CONFIGURED({ provider: "vercel" });
    expect(err.code).toBe("models.PROVIDER_NOT_CONFIGURED");
    expect(err).toBeInstanceOf(Error);
  });

  it("renders templated messages identical to the throw sites they mirror", () => {
    expect(
      modelErrors.MODEL_NOT_FOUND({ model: "x", searched: ["local"] }).message
    ).toBe('No configured provider lists "x" (searched: local).');

    expect(
      modelErrors.MODEL_KIND_MISMATCH({
        actual: "embedding",
        expected: "text",
        model: "m",
        provider: "vercel",
      }).message
    ).toBe('Provider "vercel" model "m" is kind "embedding", expected "text".');

    expect(
      modelErrors.CAPABILITY_UNSUPPORTED({
        capability: "embedding models",
        provider: "codex",
      }).message
    ).toBe('Provider "codex" does not support embedding models.');
  });

  it("carries the HTTP-style status hint", () => {
    expect(modelErrors.MODEL_KIND_MISMATCH.status).toBe(422);
    expect(modelErrors.CAPABILITY_UNSUPPORTED.status).toBe(501);
    expect(modelErrors.INVALID_EMBEDDING_JSON.status).toBe(400);
  });
});

describe("modelAudit catalog", () => {
  it("prefixes actions and fixes the target type", () => {
    const input = modelAudit.MODEL_DOWNLOAD({
      actor: { id: "model-manager", type: "system" },
      target: { id: "Xenova/all-MiniLM-L6-v2" },
    });
    expect(input.action).toBe("models.MODEL_DOWNLOAD");
    expect(input.target?.type).toBe("model");
    expect(input.target?.id).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("exposes the default target on the factory", () => {
    expect(modelAudit.PROVIDER_CONFIGURE.target).toBe("provider");
  });
});
