import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { MODULE_MIME } from "@foundry/modules/constants";
import { defineModuleVersion, moduleIdSchema } from "@foundry/modules/domain";
import { parseModuleManifest } from "@foundry/modules/manifest";
import { encodeModulePackage } from "@foundry/modules/package";
import { MODULE_SDK_EMITTED } from "@foundry/modules/sdk/emitted";
import { build } from "bun";
import { SHEETS_MODULE_ID, SHEETS_PACKAGE_PATH } from ".";

/**
 * Builds Sheets into a Module package: the Program and View bundled
 * with Bun, the emitted Module SDK beside them, and the Manifest, as one
 * frozen release Works imports through its package path.
 */
const root = new URL("../", import.meta.url);

/**
 * One self-contained script. The package carries text files at fixed
 * paths, so a bundle that splits into chunks or emits assets (WebAssembly,
 * workers) is refused rather than shipped without its parts.
 */
async function bundle(entry: string, target: "browser" | "bun") {
  const built = await build({
    entrypoints: [new URL(entry, root).pathname],
    format: "esm",
    target,
  });
  if (!built.success) {
    throw new AggregateError(built.logs, `Could not bundle ${entry}`);
  }
  const [output, ...extra] = built.outputs;
  if (output?.kind !== "entry-point" || extra.length > 0) {
    const paths = built.outputs.map(({ path }) => path).join(", ");
    throw new Error(
      `${entry} must bundle to one script, but Bun wrote: ${paths}`
    );
  }
  return output.text();
}

const files: Record<string, string> = {
  "outputs/program.js": await bundle("src/program.ts", "bun"),
  "outputs/sdk.js": MODULE_SDK_EMITTED.esm,
  "outputs/view.html": await readFile(new URL("src/view.html", root), "utf8"),
  // The View bundles HyperFormula (GPL-3.0-only); see the README.
  "outputs/view.js": await bundle("src/view.tsx", "browser"),
};
const manifestText = await readFile(
  new URL("foundry.module.json", root),
  "utf8"
);
const manifest = parseModuleManifest(JSON.parse(manifestText));
const bytes = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [
    path,
    new TextEncoder().encode(text),
  ])
);
const artifacts = new ArtifactManager({ store: new InMemoryArtifactStore() });
const artifact = await artifacts.create({
  entries: Object.fromEntries(
    Object.entries(bytes).map(([path, data]) => [path, { bytes: data }])
  ),
  freeze: { tag: "1.0.0" },
  name: "Sheets",
  type: MODULE_MIME,
});
const { content } = artifact;
if (!(content && "tree" in content)) {
  throw new Error("The Sheets release has no Content");
}
const module = {
  artifactId: artifact.id,
  id: moduleIdSchema.parse(SHEETS_MODULE_ID),
};
const version = defineModuleVersion({ artifact, content, manifest, module });
const encoded = await encodeModulePackage({
  artifact,
  content,
  files: bytes,
  module,
  version,
});
await mkdir(new URL("./", SHEETS_PACKAGE_PATH), { recursive: true });
await writeFile(SHEETS_PACKAGE_PATH, encoded);
process.stdout.write(
  `Built ${SHEETS_PACKAGE_PATH.pathname} (${String(encoded.length)} characters)\n`
);
