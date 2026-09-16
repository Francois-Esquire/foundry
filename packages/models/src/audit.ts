import { defineAuditCatalog } from "evlog";

export const modelAudit = defineAuditCatalog("models", {
  MODEL_DOWNLOAD: { target: "model" },
  PROVIDER_CONFIGURE: { target: "provider" },
});

declare module "evlog" {
  interface RegisteredAuditCatalogs {
    models: typeof modelAudit;
  }
}
