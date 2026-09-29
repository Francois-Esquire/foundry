import type { runInternalAnalysis } from "../lib/internal-analysis";
import type {
  SemanticsManifest,
  SemanticsModuleIndex,
} from "../lib/semantics-types";
import { bindInternals } from "./internals";

export async function loadInternals(
  packageId: string,
  survey: string,
  signal: AbortSignal
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
  const [report, index] = await Promise.all([
    read<ReturnType<typeof runInternalAnalysis>>(`internals/${name}.json`),
    read<SemanticsModuleIndex>(manifest.files.moduleIndex),
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
  internals.architecture = { primitives, review, rewiring };
  return internals;
}
