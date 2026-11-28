import { describe, expect, it } from "vitest";

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
    expect(modelErrors.MODEL_NOT_FOUND.status).toBe(404);
  });
});
