import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { reviewPackageArchitecture } from "../../src/lib/architecture-review";
import { analyzeInternalResponsibilities } from "../../src/lib/internal-responsibility";
import { analyzeInternalRewiring } from "../../src/lib/internal-rewiring";
import { analyzeInternalPackageTopology } from "../../src/lib/internal-topology";
import { analyzePackageLocal } from "../../src/lib/package-local";
import type { PackageLocalReport } from "../../src/lib/package-local-types";
import { analyzePrimitiveConventions } from "../../src/lib/primitive-convention";
import {
  DEFAULT_SEMANTICS_CACHE,
  lookupPackage,
} from "../../src/lib/semantics-cache";
import { packageLocalFingerprint } from "../../src/lib/semantics-fingerprint";
import type { SemanticsManifestPackage } from "../../src/lib/semantics-types";
import { analyzeSymbolLocality } from "../../src/lib/symbol-locality";

import type { AtlasInternals } from "../../src/web/internals";
import { bindInternals } from "../../src/web/internals";
import type { AtlasFile } from "../../src/web/types";

type UnavailableReason =
  | "missing-package"
  | "package-changed"
  | "source-changed"
  | "analysis-failed";

export type AtlasInternalsResult =
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
      internals: AtlasInternals;
    };

export function loadInternals(
  root: string,
  pkg: SemanticsManifestPackage,
  files: readonly Pick<AtlasFile, "id" | "path">[],
  surveyGeneratedAt: string,
  includeArchitecture = false
): AtlasInternalsResult {
  const unavailable = (reason: UnavailableReason): AtlasInternalsResult => ({
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
    const topology = analyzeInternalPackageTopology(report);
    const locality = analyzeSymbolLocality(report, topology);
    const responsibilities = analyzeInternalResponsibilities(
      report,
      topology,
      locality
    );
    const internals = bindInternals(
      topology,
      locality,
      files,
      responsibilities
    );
    if (includeArchitecture) {
      const primitives = analyzePrimitiveConventions(
        report,
        topology,
        locality,
        responsibilities
      );
      const rewiring = analyzeInternalRewiring(
        report,
        topology,
        locality,
        responsibilities,
        primitives
      );
      internals.architecture = {
        primitives,
        review: reviewPackageArchitecture(rewiring),
        rewiring,
      };
    }
    if (packageLocalFingerprint(root, unit).combined !== fingerprint) {
      return unavailable("source-changed");
    }
    return {
      analysisSource: useCache ? "cache" : "fresh",
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
