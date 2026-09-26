import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInternalAnalysis } from "../lib/internal-analysis";
import { encodePackageFile, generateSemantics } from "../lib/semantics";
import { writeJsonAtomic } from "../lib/semantics-cache";
import { loadSemanticsConfig } from "../lib/semantics-discover";
import { generateSemanticsHistory } from "../lib/semantics-history";
import type { SemanticsManifest } from "../lib/semantics-types";
import type { resolveWorkspace } from "./workspace";

export async function scan(
  workspace: Awaited<ReturnType<typeof resolveWorkspace>>,
  history: boolean
) {
  const config = {
    ...loadSemanticsConfig(workspace.root),
    output: workspace.output,
  };
  const result = await generateSemantics({
    cache: workspace.cache,
    config,
    failFast: true,
    mode: "incremental",
    onProgress(event) {
      if (event.kind === "phase") {
        process.stderr.write(
          `${event.phase}${event.detail ? `: ${event.detail}` : ""}\n`
        );
      }
    },
    root: workspace.root,
  });
  if (result.packages.failed) {
    throw new Error(`${result.packages.failed} packages failed analysis.`);
  }
  const manifest = JSON.parse(
    await readFile(result.manifest, "utf8")
  ) as SemanticsManifest;
  await mkdir(join(workspace.output, "manifests"), { recursive: true });
  await mkdir(join(workspace.output, "internals"), { recursive: true });
  for (const pkg of manifest.packages) {
    const name = `${encodePackageFile(pkg.id)}.json`;
    await copyFile(
      join(workspace.root, pkg.path, "package.json"),
      join(workspace.output, "manifests", name)
    );
    if (pkg.status !== "complete") {
      continue;
    }
    process.stderr.write(`internals: ${pkg.id}\n`);
    writeJsonAtomic(
      join(workspace.output, "internals", name),
      runInternalAnalysis({
        root: workspace.root,
        target: pkg.path,
        through: "review",
      })
    );
  }
  if (history) {
    const historical = await generateSemanticsHistory({
      cache: join(workspace.cache, "history"),
      config,
      output: join(workspace.output, "history"),
      root: workspace.root,
    });
    if (historical.manifest.generation.failedSnapshots) {
      throw new Error("Some history checkpoints failed analysis.");
    }
  }
}
