import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { MODULE_MIME } from "@foundry/modules/constants";
import { defineModuleVersion, moduleIdSchema } from "@foundry/modules/domain";
import { parseModuleManifest } from "@foundry/modules/manifest";
import { encodeModulePackage } from "@foundry/modules/package";
import { MODULE_SDK_EMITTED } from "@foundry/modules/sdk/emitted";
import { build } from "bun";
import { MARKDOWN_FIXTURE_MODULE_ID, MARKDOWN_FIXTURE_PACKAGE_PATH } from ".";

/**
 * Builds the fixture into a Module package: the Program and View bundled
 * with Bun, the emitted Module SDK beside them, and the Manifest, as one
 * frozen release Works imports through its package path.
 */
const root = new URL("../", import.meta.url);

async function bundle(entry: string, target: "browser" | "bun") {
  const built = await build({
    entrypoints: [new URL(entry, root).pathname],
    format: "esm",
    target,
  });
  const [output] = built.outputs;
  if (!(built.success && output)) {
    throw new AggregateError(built.logs, `Could not bundle ${entry}`);
  }
  return output.text();
}

const files: Record<string, string> = {
  "outputs/program.js": await bundle("src/program.ts", "bun"),
  "outputs/sdk.js": MODULE_SDK_EMITTED.esm,
  "outputs/view.html": await readFile(new URL("src/view.html", root), "utf8"),
  "outputs/view.js": await bundle("src/view.ts", "browser"),
  "outputs/workflows.html": await readFile(
    new URL("src/workflows.html", root),
    "utf8"
  ),
  "outputs/workflows.js": await bundle("src/workflows.ts", "browser"),
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
  name: "Markdown",
  type: MODULE_MIME,
});
const { content } = artifact;
if (!(content && "tree" in content)) {
  throw new Error("The fixture release has no Content");
}
const module = {
  artifactId: artifact.id,
  id: moduleIdSchema.parse(MARKDOWN_FIXTURE_MODULE_ID),
};
const version = defineModuleVersion({ artifact, content, manifest, module });
const encoded = await encodeModulePackage({
  artifact,
  content,
  files: bytes,
  module,
  version,
});
await mkdir(new URL("./", MARKDOWN_FIXTURE_PACKAGE_PATH), { recursive: true });
await writeFile(MARKDOWN_FIXTURE_PACKAGE_PATH, encoded);
process.stdout.write(
  `Built ${MARKDOWN_FIXTURE_PACKAGE_PATH.pathname} (${String(encoded.length)} characters)\n`
);
