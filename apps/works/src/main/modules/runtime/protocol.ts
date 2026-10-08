import { protocol } from "electron";
import type { ModuleSessions } from "./controller";
import { createModuleProxy } from "./proxy";

export function registerModuleScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        corsEnabled: true,
        secure: true,
        standard: true,
        supportFetchAPI: true,
      },
      scheme: "module-app",
    },
  ]);
}

export function registerModuleProtocol(sessions: ModuleSessions): void {
  protocol.handle("module-app", createModuleProxy(sessions));
}
