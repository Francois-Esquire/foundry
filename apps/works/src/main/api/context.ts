import { ModuleSettingsError } from "@foundry/modules/settings";
import { ModuleStoreConflictError } from "@foundry/modules/store/contract";
import { ORPCError, os } from "@orpc/server";
import {
  type ArtifactExplorer,
  ArtifactOpenError,
} from "~/main/artifacts/explorer";
import type { ExecutionAudit } from "~/main/execution/audit";
import { type ModuleAccess, ModuleAccessError } from "~/main/modules/access";
import type { ModuleAuthoring } from "~/main/modules/authoring/service";
import type { ModuleBuilds } from "~/main/modules/builds/controller";
import type { ModuleLibrary } from "~/main/modules/library";
import type { ModulePower } from "~/main/modules/power";
import type { ModuleSessions } from "~/main/modules/runtime/controller";
import type { ModuleSettings } from "~/main/modules/settings";
import type { SystemTheme } from "~/main/system/theme";
import type { Vault } from "~/main/vault/vault";

/**
 * What every procedure receives. Supplied once when the port is upgraded.
 * Main supplies every service; a renderer test supplies the ones it needs,
 * and a procedure whose service is missing answers that it is unavailable.
 */
export interface RouterContext {
  access?: Pick<ModuleAccess, "approve" | "get" | "revoke">;
  artifacts?: ArtifactExplorer;
  audit?: Pick<ExecutionAudit, "watch">;
  authoring?: ModuleAuthoring;
  builds?: ModuleBuilds;
  moduleSettings?: Pick<ModuleSettings, "get" | "set">;
  modules: ModuleLibrary;
  power?: Pick<ModulePower, "get" | "set">;
  sessions?: ModuleSessions;
  theme?: Pick<SystemTheme, "adopt" | "set" | "watch">;
  vault: Vault;
}

export const base = os.$context<RouterContext>();

type Service = Exclude<keyof RouterContext, "modules" | "vault">;

const UNAVAILABLE: Readonly<Record<Service, string>> = {
  access: "Module access is unavailable",
  artifacts: "Artifacts are unavailable",
  audit: "Activity is unavailable",
  authoring: "Module chat is unavailable",
  builds: "Module builds are unavailable",
  moduleSettings: "Module settings are unavailable",
  power: "Module on/off is unavailable",
  sessions: "Module sessions are unavailable",
  theme: "The system theme is unavailable",
};

type Providing<S extends Service> = RouterContext & {
  [K in S]-?: NonNullable<RouterContext[K]>;
};

function provides<S extends Service>(
  context: RouterContext,
  services: readonly S[]
): context is Providing<S> {
  return services.every((service) => context[service] !== undefined);
}

/**
 * Procedures that need `services`: refused as unavailable (with `message`,
 * or what each missing service says) when the host lacks one, and handed
 * them as present otherwise.
 */
export function requires<S extends Service>(
  services: readonly S[],
  message?: string
) {
  return base.middleware(({ context, next }) => {
    if (!provides(context, services)) {
      const missing = services.filter((service) => !context[service]);
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message:
          message ?? missing.map((service) => UNAVAILABLE[service]).join(" "),
      });
    }
    return next({ context });
  });
}

/**
 * Refusals a person can act on, as typed RPC errors: a missing Artifact or
 * stale editor choice, a conflicting change, or settings that break a
 * requirement. Anything else passes through as it is.
 */
export const refusals = base.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    throw refusal(error) ?? error;
  }
});

function refusal(error: unknown): ORPCError<string, unknown> | null {
  if (error instanceof ArtifactOpenError) {
    return new ORPCError(error.code, { cause: error, message: error.message });
  }
  if (
    error instanceof ModuleAccessError ||
    error instanceof ModuleStoreConflictError
  ) {
    return new ORPCError("CONFLICT", { cause: error, message: error.message });
  }
  if (error instanceof ModuleSettingsError) {
    return new ORPCError("BAD_REQUEST", {
      cause: error,
      data: { problems: error.problems },
      message: error.message,
    });
  }
  return null;
}
