import type { runInternalAnalysis } from "../lib/internal-analysis";
import type {
  SemanticsManifest,
  SemanticsModuleIndex,
} from "../lib/semantics-types";
import type { SurfaceReport } from "../lib/types";
import { bindInternals } from "./internals";

export async function loadInternals(
  packageId: string,
  survey: string,
  signal: AbortSignal,
  recordedChange = false
) {
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(`./data/${path}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Could not load ${path} (${response.status}).`);
    }
    return (await response.json()) as T;
  };
  const manifest = await read<SemanticsManifest>("manifest.json");
  if (manifest.generatedAt !== survey) {
    throw new Error("The survey changed. Reload Atlas to align its evidence.");
  }
  const name = encodeURIComponent(packageId.replaceAll("/", "__"));
  const reportPath = manifest.packages.find(
    (pkg) => pkg.id === packageId
  )?.report;
  const [report, index, history] = await Promise.all([
    read<ReturnType<typeof runInternalAnalysis>>(`internals/${name}.json`),
    read<SemanticsModuleIndex>(manifest.files.moduleIndex),
    recordedChange && reportPath
      ? read<Pick<SurfaceReport, "churn">>(reportPath).catch(() => undefined)
      : undefined,
  ]);
  const { topology, locality, responsibilities, primitives, rewiring, review } =
    report;
  if (
    topology.package.id !== packageId ||
    !locality ||
    !responsibilities ||
    !primitives ||
    !rewiring ||
    !review
  ) {
    throw new Error("Incomplete internal evidence. Run atlas scan again.");
  }
  if ((await read<SemanticsManifest>("manifest.json")).generatedAt !== survey) {
    throw new Error("The survey changed. Reload Atlas to align its evidence.");
  }
  const internals = bindInternals(
    topology,
    locality,
    index.modules.filter((file) => file.package === packageId),
    responsibilities
  );
  internals.churn = history?.churn;
  internals.architecture = { primitives, review, rewiring };
  return internals;
}
