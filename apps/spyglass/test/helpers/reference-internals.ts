import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { packageInternals } from "../../src/lib/internal-analysis";
import { fileRolesLens } from "../../src/lib/lenses/file-roles";
import type { FileRolesPackage } from "../../src/lib/lenses/file-roles-types";
import { analyzePackageLocal } from "../../src/lib/package-local";
import type { PackageLocalReport } from "../../src/lib/package-local-types";
import {
  DEFAULT_SEMANTICS_CACHE,
  lookupPackage,
} from "../../src/lib/semantics-cache";
import { packageLocalFingerprint } from "../../src/lib/semantics-fingerprint";
import type { SemanticsManifestPackage } from "../../src/lib/semantics-types";
import type { SpyglassFile } from "../../src/web/data/types";
import type { SpyglassInternals } from "../../src/web/layout/internals";
import { bindInternals } from "../../src/web/layout/internals";

type UnavailableReason =
  | "missing-package"
  | "package-changed"
  | "source-changed"
  | "analysis-failed";

export type SpyglassInternalsResult =
  | {
      status: "unavailable";
      packageId: string;
      reason: UnavailableReason;
    }
  | {
      status: "available";
      packageId: string;
      surveyGeneratedAt: string;
      sourceFingerprint: string;
      localSchemaVersion: number;
      analysisSource: "cache" | "fresh";
      /** The `file-roles` lens's entry the internals were bound with. */
      fileRoles: FileRolesPackage | undefined;
      internals: SpyglassInternals;
    };

export function loadInternals(
  root: string,
  pkg: SemanticsManifestPackage,
  files: readonly Pick<SpyglassFile, "id" | "path">[],
  surveyGeneratedAt: string,
  includeArchitecture = false
): SpyglassInternalsResult {
  const unavailable = (reason: UnavailableReason): SpyglassInternalsResult => ({
    packageId: pkg.id,
    reason,
    status: "unavailable",
  });
  const unit = {
    ...pkg,
    analyzable: true,
    manifestPath: `${pkg.path}/package.json`,
  };
  if (!existsSync(resolve(root, unit.manifestPath))) {
    return unavailable("missing-package");
  }
  try {
    const fingerprint = packageLocalFingerprint(root, unit).combined;
    const cached = lookupPackage<PackageLocalReport>(
      resolve(root, DEFAULT_SEMANTICS_CACHE),
      pkg.id,
      "package-local",
      fingerprint
    );
    const useCache =
      cached.hit &&
      cached.value.package.path === pkg.path &&
      cached.value.package.name === pkg.id;
    const report = useCache
      ? cached.value
      : analyzePackageLocal({ root, target: pkg.path });
    if (report.package.name !== pkg.id || report.package.path !== pkg.path) {
      return unavailable("package-changed");
    }
    const {
      topology,
      locality,
      responsibilities,
      primitives,
      rewiring,
      review,
    } = packageInternals(report);
    // The roles the file-roles lens would save for this package.
    const [roles] = fileRolesLens.derive(
      {
        missing: [],
        packages: [
          {
            id: pkg.id,
            primitives,
            rewiring,
            root: topology.package.root,
            topology,
          },
        ],
      },
      {}
    ).packages;
    const internals = bindInternals(
      topology,
      locality,
      files,
      responsibilities,
      roles
    );
    if (includeArchitecture) {
      internals.architecture = { primitives, review, rewiring };
    }
    if (packageLocalFingerprint(root, unit).combined !== fingerprint) {
      return unavailable("source-changed");
    }
    return {
      analysisSource: useCache ? "cache" : "fresh",
      fileRoles: roles,
      internals,
      localSchemaVersion: report.schemaVersion,
      packageId: pkg.id,
      sourceFingerprint: fingerprint,
      status: "available",
      surveyGeneratedAt,
    };
  } catch {
    return unavailable("analysis-failed");
  }
}
