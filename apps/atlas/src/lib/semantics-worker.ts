import * as fs from "node:fs";
import * as path from "node:path";
import { assembleSurfaceReport } from "./assemble";
import { analyzePackageLocal } from "./package-local";
import type { PackageLocalReport } from "./package-local-types";
import { encodePackageFile } from "./semantics";
import { deriveWorkspaceSurface } from "./workspace-derive";

// One analysis stage in its own process, so the materializer can bound
// concurrency and release each TypeScript project by exit. Nothing is
// reshaped: the local stage writes the bare PackageLocalReport, the derive
// stage writes the assembled SurfaceReport per package plus its timing.
//
//   bun src/semantics-worker.ts --stage local --root <dir> --target <rel-path> --out <file>
//   bun src/semantics-worker.ts --stage derive --root <dir> --locals <json-list> --out <dir>
//     --now <iso> [--profile full|temporal]

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key === undefined || value === undefined || !key.startsWith("--")) {
    throw new Error("semantics-worker: options are --key value pairs");
  }
  args.set(key.slice(2), value);
}
const stage = args.get("stage") ?? "local";
const root = args.get("root");
const out = args.get("out");
if (root === undefined || out === undefined) {
  throw new Error("semantics-worker needs --root and --out");
}

if (stage === "local") {
  const target = args.get("target");
  if (target === undefined) {
    throw new Error("--stage local needs --target");
  }
  const report = analyzePackageLocal({ root, target });
  fs.writeFileSync(out, JSON.stringify(report));
} else if (stage === "derive") {
  const locals = args.get("locals");
  const now = args.get("now");
  const profile = args.get("profile") ?? "full";
  if (locals === undefined || now === undefined) {
    throw new Error("--stage derive needs --locals and --now");
  }
  if (profile !== "full" && profile !== "temporal") {
    throw new Error(`Unknown analysis profile: ${profile}`);
  }
  const files = JSON.parse(fs.readFileSync(locals, "utf8")) as string[];
  const reports = files.map(
    (file) => JSON.parse(fs.readFileSync(file, "utf8")) as PackageLocalReport
  );
  const derivation = await deriveWorkspaceSurface(reports, {
    now: new Date(now),
    profile,
    root,
  });
  fs.mkdirSync(out, { recursive: true });
  for (const local of reports) {
    const derived = derivation.packages[local.package.path];
    if (derived === undefined) {
      continue;
    }
    const id = local.package.name ?? local.package.path;
    fs.writeFileSync(
      path.join(out, `${encodePackageFile(id)}.json`),
      JSON.stringify(assembleSurfaceReport(local, derived))
    );
  }
  fs.writeFileSync(
    path.join(out, "derivation.json"),
    JSON.stringify({
      diagnostics: derivation.diagnostics,
      timing: derivation.timing,
    })
  );
} else {
  throw new Error(`Unknown worker stage: ${stage}`);
}
