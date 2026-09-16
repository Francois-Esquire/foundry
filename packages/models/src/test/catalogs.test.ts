import { afterEach, describe, expect, it } from "vitest";

import { modelAudit } from "../audit";
import { modelErrors } from "../errors";
import { configureModelObservability } from "../logger";
import { ModelManager } from "../manager";
import { vercelBinding } from "../vercel";
import { fakeProvider } from "./helpers/model";

describe("modelErrors catalog", () => {
  it("prefixes every code with `models.`", () => {
    const err = modelErrors.PROVIDER_NOT_REGISTERED({ provider: "vercel" });
    expect(err.code).toBe("models.PROVIDER_NOT_REGISTERED");
    expect(err).toBeInstanceOf(Error);
  });

  it("renders templated messages identical to the throw sites they mirror", () => {
    expect(
      modelErrors.MODEL_NOT_REGISTERED({ model: "x", provider: "local" })
        .message
    ).toBe('Model "x" is not registered on provider "local".');

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

describe("audit wiring", () => {
  afterEach(() => {
    configureModelObservability({ enabled: true });
  });

  function drainAudits(enabled: boolean) {
    const audits: { action?: string; target?: { id?: string } }[] = [];
    configureModelObservability({
      enabled,
      logger: {
        drain: (ctx) => {
          const event = ctx.event as {
            audit?: { action?: string; target?: { id?: string } };
          };
          if (event.audit) {
            audits.push(event.audit);
          }
        },
      },
    });
    return audits;
  }

  it("manager.configure emits a PROVIDER_CONFIGURE audit per provider", () => {
    const audits = drainAudits(true);
    const manager = new ModelManager({
      bindings: [vercelBinding],
      providers: [fakeProvider("vercel")],
    });
    manager.configure({ vercelApiKey: "vk" });

    expect(audits.map((a) => a.action)).toContain("models.PROVIDER_CONFIGURE");
    expect(audits.some((a) => a.target?.id === "vercel")).toBe(true);
  });

  it("does not emit audits when observability is disabled", () => {
    const audits = drainAudits(false);
    const manager = new ModelManager({
      bindings: [vercelBinding],
      providers: [fakeProvider("vercel")],
    });
    manager.configure({ vercelApiKey: "vk" });
    expect(audits).toHaveLength(0);
  });
});
