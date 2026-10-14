import type { CompositionEvidence } from "../internal-rewiring-types";
import type {
  InternalModuleNode,
  InternalModuleRoleAssignment,
} from "../internal-topology-types";
import type { PrimitiveModuleFinding } from "../primitive-convention-types";
import { byId } from "../workspace-projection";
import type {
  FileRole,
  FileRoleModule,
  FileRolesPackage,
} from "./file-roles-types";
import { FILE_ROLES_SCHEMA_VERSION } from "./file-roles-types";
import type { Lens } from "./lens-types";
import { readPackageInternals, rootRelative } from "./package-internals";

type RoleEvidence = Pick<
  PrimitiveModuleFinding,
  "module" | "symbols" | "unresolvedSymbols"
> & {
  composition: Pick<PrimitiveModuleFinding["composition"], "scopes">;
  fragmentation: Pick<
    PrimitiveModuleFinding["fragmentation"],
    "localGroups" | "crossResponsibility" | "packageWide"
  >;
};

/** One package's fields the lens reads; module ids are the package's own. */
interface FileRolesSourcePackage {
  id: string;
  primitives: { modules: RoleEvidence[] };
  rewiring: {
    composition: Pick<CompositionEvidence, "module" | "compositionRoot">[];
  };
  root: string;
  topology: {
    modules: Pick<InternalModuleNode, "id" | "fanIn">[];
    roles: InternalModuleRoleAssignment[];
    summary: { highFanCutoff: { fanIn: number } };
  };
}

/** Every dataset field the lens reads. */
export interface FileRolesSource {
  missing: string[];
  packages: FileRolesSourcePackage[];
}

/** The first role that holds, in the order `FileRole` documents. */
function roleOf(
  compositionRoot: boolean,
  evidence: RoleEvidence | undefined
): FileRole | undefined {
  if (compositionRoot) {
    return "junction";
  }
  if (evidence === undefined) {
    return;
  }
  if (evidence.composition.scopes === "mixed-scope") {
    return "mixed";
  }
  const { crossResponsibility, localGroups, packageWide } =
    evidence.fragmentation;
  if (localGroups === 0 && crossResponsibility + packageWide > 0) {
    return "commons";
  }
  if (evidence.symbols > 0 && evidence.unresolvedSymbols === evidence.symbols) {
    return "unknown";
  }
}

function derivePackage(pkg: FileRolesSourcePackage): FileRolesPackage {
  const evidence = new Map(
    pkg.primitives.modules.map((module) => [module.module, module])
  );
  const roots = new Set(
    pkg.rewiring.composition
      .filter((module) => module.compositionRoot)
      .map((module) => module.module)
  );
  const highFanIn = new Set(
    pkg.topology.roles
      .filter((assignment) => assignment.roles.includes("high-fan-in"))
      .map((assignment) => assignment.module)
  );
  const modules = pkg.topology.modules.map((module): FileRoleModule => {
    const role = roleOf(roots.has(module.id), evidence.get(module.id));
    return {
      fanIn: module.fanIn,
      highFanIn: highFanIn.has(module.id),
      module: rootRelative(pkg.root, module.id),
      ...(role !== undefined && { role }),
    };
  });
  return {
    highFanInCutoff: pkg.topology.summary.highFanCutoff.fanIn,
    id: pkg.id,
    modules: modules.sort((a, b) => byId(a.module, b.module)),
  };
}

/**
 * Each module's role in its package, and its fan-in against the package's
 * high fan-in cutoff, joined from the topology, the primitive conventions,
 * and the rewiring's composition evidence. Nothing is measured again: the
 * fan-in, the `high-fan-in` role, and the cutoff are the topology's own.
 */
export const fileRolesLens: Lens<"file-roles", FileRolesSource> = {
  derive: ({ missing, packages }) => ({
    missing,
    packages: packages.map(derivePackage).sort((a, b) => byId(a.id, b.id)),
  }),
  id: "file-roles",
  read: async (reader) => {
    const { missing, packages } = await readPackageInternals(reader);
    return {
      missing,
      packages: packages.map(({ id, internals, root }) => ({
        id,
        primitives: internals.primitives,
        rewiring: internals.rewiring,
        root,
        topology: internals.topology,
      })),
    };
  },
  schemaVersion: FILE_ROLES_SCHEMA_VERSION,
  settings: [],
};
