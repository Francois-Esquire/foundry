import { defineErrorCatalog } from "evlog";

export const modelErrors = defineErrorCatalog("models", {
  CAPABILITY_UNSUPPORTED: {
    message: ({
      provider,
      capability,
    }: {
      provider: string;
      capability: string;
    }) => `Provider "${provider}" does not support ${capability}.`,
    status: 501,
    why: "The provider does not implement the requested capability.",
  },
  MODEL_KIND_MISMATCH: {
    message: ({
      provider,
      model,
      actual,
      expected,
    }: {
      provider: string;
      model: string;
      actual: string;
      expected: string;
    }) =>
      `Provider "${provider}" model "${model}" is kind "${actual}", expected "${expected}".`,
    status: 422,
  },
  MODEL_NOT_FOUND: {
    message: ({
      model,
      searched,
      skipped,
    }: {
      model: string;
      searched: readonly string[];
      skipped?: string;
    }) =>
      `No configured provider lists "${model}" (searched: ${searched.join(", ") || "none"}${skipped ? `; skipped: ${skipped}` : ""}).`,
    status: 404,
    why: "Selections are checked against each provider's catalog; an id no catalog lists is refused rather than passed through.",
  },
  NO_MODEL_OF_KIND: {
    message: ({ provider, kind }: { provider: string; kind: string }) =>
      `Provider "${provider}" has no ${kind} model registered.`,
    status: 404,
  },
  PROVIDER_NOT_CONFIGURED: {
    message: ({ provider }: { provider: string }) =>
      `Provider "${provider}" is not configured here.`,
    status: 404,
  },
  PROVIDER_UNAVAILABLE: {
    message: ({ kind, provider }: { kind: string; provider?: string }) =>
      provider === undefined
        ? `No available provider serves "${kind}".`
        : `Provider "${provider}" is unavailable.`,
    status: 503,
  },
  ROUTE_STALE: {
    message: ({ model, provider }: { model: string; provider: string }) =>
      `The route ${provider}/${model} left the provider set before it was opened.`,
    status: 409,
  },
  SELECTION_AMBIGUOUS: {
    message: ({ selection }: { selection: string }) =>
      `"${selection}" names a provider and model and also a model id; name it as { provider, model } instead.`,
    status: 409,
  },
});

declare module "evlog" {
  interface RegisteredErrorCatalogs {
    models: typeof modelErrors;
  }
}
