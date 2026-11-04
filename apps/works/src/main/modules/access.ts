import type { Installation, ModuleVersion } from "@foundry/modules/domain";
import {
  grantMatches,
  isGranted,
  type ModuleAccessRequest,
  type ModuleNetworkAccessRequest,
  moduleAccessRequests,
  NETWORK_GRANT,
} from "@foundry/modules/grants";
import type {
  InstallationGrant,
  ModuleStore,
} from "@foundry/modules/store/contract";
import type { GrantChange, WorksCapability } from "~/main/gateway/provider-kit";
import { WORKS_TASKS } from "~/shared/execution";
import type {
  ModuleAccessRequestView,
  ModuleAccessView,
  ScopeArea,
} from "~/shared/module-access";
import { OBSERVATION } from "~/shared/observations";
import type { WorksExecution } from "../execution/contract";
import { capabilityProviders } from "./capabilities";
import type { ModuleLibrary } from "./library";
import type { ModuleRuntime } from "./runtime/controller";
import {
  ensureModuleInstallation,
  installationPrincipal,
  moduleInstallationId,
} from "./runtime/installation";
import { filesPersistence } from "./runtime/private-files";

export class ModuleAccessError extends Error {
  override readonly name = "ModuleAccessError";
}

export interface ModuleAccessOptions {
  /**
   * What can be requested: the Gateway capabilities and `network`. Each
   * says what an approval reaches and what happens when its Grant changes;
   * a change is reported done once that settles.
   */
  readonly capabilities: readonly WorksCapability[];
  readonly execution: Pick<WorksExecution, "dispatch">;
  readonly library: Pick<ModuleLibrary, "details" | "release">;
  readonly now?: () => Date;
  /** Cancels a revoked Grant's active Invocations before its hooks run. */
  readonly runtime: Pick<ModuleRuntime, "revoked">;
  /** The library's Artifact-backed ModuleStore: Grants live on the Installation. */
  readonly store: ModuleStore;
}

/**
 * `network`, which the sandbox enforces rather than the Gateway. A
 * Program's network policy is fixed when it starts, so a Grant change
 * restarts the Module's running apps (`restart` resolves with how many once
 * the old Programs have stopped); the change is not reported done while an
 * old Program still holds the previous access.
 */
export function networkAccess(
  restart: (moduleId: string) => Promise<number>
): WorksCapability {
  const restarting =
    (change: "approved" | "revoked") =>
    async ({ moduleId }: GrantChange) => {
      try {
        return { restarted: await restart(moduleId) };
      } catch (error) {
        throw new ModuleAccessError(
          `Network access was ${change}, but the running app did not stop. Turn the Module off to stop it.`,
          { cause: error }
        );
      }
    };
  return {
    approved: restarting("approved"),
    capability: NETWORK_GRANT.capability,
    revoked: restarting("revoked"),
  };
}

/**
 * The Access panel's service: a Module's requests, its Installation's
 * Grants, and approval and revocation. Each change is a `system` engine run
 * that writes the Grants on the Installation; there is no other approval
 * store. Module settings never reach this.
 */
export class ModuleAccess {
  readonly #capabilities: readonly WorksCapability[];
  readonly #execution: ModuleAccessOptions["execution"];
  readonly #library: ModuleAccessOptions["library"];
  readonly #now: () => Date;
  readonly #runtime: ModuleAccessOptions["runtime"];
  readonly #store: ModuleStore;

  constructor(options: ModuleAccessOptions) {
    this.#capabilities = options.capabilities;
    this.#execution = options.execution;
    this.#library = options.library;
    this.#now = options.now ?? (() => new Date());
    this.#runtime = options.runtime;
    this.#store = options.store;
  }

  async get(moduleId: string): Promise<ModuleAccessView> {
    const { installation, version, grants } = await this.#target(moduleId);
    const requests = version
      ? await this.#requests(moduleId, installation, version)
      : [];
    return view(this.#capabilities, {
      grants,
      installation,
      moduleId,
      requests,
      version,
    });
  }

  /**
   * Approve one request of the Module's Version: the Installation's Grant
   * for it becomes the request's resolved digest. Creates the Module's
   * Installation at its newest release when it has none.
   */
  approve(moduleId: string, capability: string): Promise<ModuleAccessView> {
    return this.#execution.dispatch(
      WORKS_TASKS.access,
      { correlation: { moduleId } },
      async (context) => {
        const target = await this.#target(moduleId);
        const { version } = target;
        if (!version) {
          throw new ModuleAccessError(
            "Build a release before approving access"
          );
        }
        const installation =
          target.installation ??
          (await ensureModuleInstallation(this.#store, version, this.#now()));
        const requests = await this.#requests(moduleId, installation, version);
        const request = requests.find(
          (candidate) => candidate.capability === capability
        );
        if (!request) {
          throw new ModuleAccessError(
            `Version ${version.tag} does not request ${capability}`
          );
        }
        const { constraintsDigest } = request;
        if (constraintsDigest === null) {
          throw new ModuleAccessError(
            `This host cannot provide ${capability}, so it cannot be approved`
          );
        }
        await this.#store.transaction(async () => {
          const current = await this.#store.loadGatewayContext(installation.id);
          if (
            !current ||
            current.installation.contentId !== version.contentId ||
            current.installation.generation !== installation.generation
          ) {
            throw new ModuleAccessError(
              "The Module's release changed while approving; review Access again"
            );
          }
          await this.#store.replaceInstallationGrants({
            expectedGeneration: current.installation.generation,
            grants: [
              ...current.grants.filter(
                (grant) => grant.capability !== capability
              ),
              { capability, constraintsDigest, version: request.version },
            ],
            installationId: installation.id,
            now: this.#now(),
          });
        });
        const restarted = await this.#capability(capability)?.approved?.({
          installationId: installation.id,
          moduleId,
        });
        context.observe({
          data: {
            action: "approve",
            capability,
            moduleId,
            tag: version.tag,
            ...restarted,
          },
          kind: "result",
          type: OBSERVATION.access,
        });
        return this.get(moduleId);
      }
    );
  }

  /**
   * Revoke one Grant. Once the revoke commits no new Invocation is admitted
   * under it, and the runtime cancels the active ones.
   */
  revoke(moduleId: string, capability: string): Promise<ModuleAccessView> {
    return this.#execution.dispatch(
      WORKS_TASKS.access,
      { correlation: { moduleId } },
      async (context) => {
        const installationId = moduleInstallationId(moduleId);
        await this.#store.transaction(async () => {
          const current = await this.#store.loadGatewayContext(installationId);
          if (
            !current?.grants.some((grant) => grant.capability === capability)
          ) {
            throw new ModuleAccessError(`${capability} is not approved`);
          }
          await this.#store.revokeInstallationGrant({
            capability,
            expectedGeneration: current.installation.generation,
            installationId,
          });
        });
        this.#runtime.revoked({ capability, installationId });
        const restarted = await this.#capability(capability)?.revoked?.({
          installationId,
          moduleId,
        });
        context.observe({
          data: { action: "revoke", capability, moduleId, ...restarted },
          kind: "result",
          type: OBSERVATION.access,
        });
        return this.get(moduleId);
      }
    );
  }

  #capability(capability: string): WorksCapability | undefined {
    return this.#capabilities.find(
      (candidate) => candidate.capability === capability
    );
  }

  /** The Installation, its Grants, and the Version Access describes. */
  async #target(moduleId: string): Promise<{
    installation: Installation | null;
    grants: readonly InstallationGrant[];
    version: ModuleVersion | null;
  }> {
    const context = await this.#store.loadGatewayContext(
      moduleInstallationId(moduleId)
    );
    if (context) {
      return {
        grants: context.grants,
        installation: context.installation,
        version: await this.#library.release(
          moduleId,
          context.installation.contentId
        ),
      };
    }
    const details = await this.#library.details(moduleId);
    if (!details) {
      throw new ModuleAccessError("Module not found");
    }
    const [newest] = details.releases;
    return {
      grants: [],
      installation: null,
      version: newest
        ? await this.#library.release(moduleId, newest.contentId)
        : null,
    };
  }

  #requests(
    moduleId: string,
    installation: Pick<Installation, "generation"> | null,
    version: ModuleVersion
  ) {
    return moduleAccessRequests({
      principal: installationPrincipal(
        {
          generation: installation?.generation ?? 0,
          id: moduleInstallationId(moduleId),
          moduleId: version.moduleId,
        },
        version
      ),
      providers: capabilityProviders(this.#capabilities),
      version,
    });
  }
}

function view(
  capabilities: readonly WorksCapability[],
  target: {
    readonly grants: readonly InstallationGrant[];
    readonly installation: Installation | null;
    readonly moduleId: string;
    readonly requests: readonly ModuleAccessRequest[];
    readonly version: ModuleVersion | null;
  }
): ModuleAccessView {
  const { grants, installation, moduleId, requests, version } = target;
  const approved = (request: ModuleAccessRequest) => isGranted(grants, request);
  const network = requests.find(
    (request): request is ModuleNetworkAccessRequest =>
      request.kind === "network" && approved(request)
  );
  /** What a capability request asks to reach, and where Access shows it. */
  const scopeOf = (request: ModuleAccessRequest) => {
    if (request.kind !== "capability") {
      return;
    }
    const scope = capabilities.find(
      (candidate) => candidate.capability === request.capability
    )?.scope;
    const reaches = scope?.of(request.request.constraints ?? null);
    return scope && reaches ? { area: scope.area, reaches } : undefined;
  };
  const scope: Record<ScopeArea, readonly string[]> = {
    artifacts: [],
    workflows: [],
  };
  for (const request of requests) {
    const reach = scopeOf(request);
    if (reach && approved(request)) {
      scope[reach.area] = reach.reaches;
    }
  }
  return {
    grants: grants.map((grant) => ({
      capability: grant.capability,
      current: requests.some((request) => grantMatches(grant, request)),
      kind:
        grant.capability === NETWORK_GRANT.capability
          ? "network"
          : "capability",
      version: grant.version,
    })),
    installation: installation ? { status: installation.status } : null,
    moduleId,
    privateFiles: version ? filesPersistence(version.manifest) : null,
    requests: requests.map((request) => ({
      ...(request.kind === "capability"
        ? { alias: request.request.alias }
        : { destinations: request.destinations.map(destinationLabel) }),
      approved: approved(request),
      availability: request.availability,
      capability: request.capability,
      kind: request.kind,
      reason: request.reason,
      required: request.required,
      ...withScope(scopeOf(request)),
      version: request.version,
    })),
    scope: {
      ...scope,
      network: network?.destinations.map(destinationLabel) ?? [],
    },
    version: version
      ? { contentId: version.contentId, tag: version.tag }
      : null,
  };
}

function withScope(scope: ModuleAccessRequestView["scope"]) {
  return scope === undefined ? {} : { scope };
}

function destinationLabel(destination: {
  readonly host: string;
  readonly ports?: readonly number[];
}): string {
  return destination.ports === undefined
    ? destination.host
    : `${destination.host}:${destination.ports.join(",")}`;
}
