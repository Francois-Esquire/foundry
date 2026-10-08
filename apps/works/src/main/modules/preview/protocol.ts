import { protocol } from "electron";
import type { ModulePreviews } from "./controller";
import { createPreviewProxy } from "./proxy";

export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        corsEnabled: true,
        secure: true,
        standard: true,
        supportFetchAPI: true,
      },
      scheme: "module-preview",
    },
  ]);
}

export function registerPreviewProtocol(previews: ModulePreviews): void {
  protocol.handle("module-preview", createPreviewProxy(previews));
}
