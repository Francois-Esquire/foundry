import type { EntryInputs, FileInputs } from "@foundry/artifacts";

import {
  ArtifactManager,
  artifactIdSchema,
  InMemoryArtifactStore,
} from "@foundry/artifacts";

import { MODULE_MIME } from "../../constants";

export const PROGRAM_FILES: FileInputs = {
  "outputs/program/server.js": { bytes: "export {};", mime: "text/javascript" },
};

export const VALID_MANIFEST = {
  capabilities: [],
  compatibility: { gateway: "1", runtime: "bun@1" },
  format: "foundry.module/1",
  program: { entry: "outputs/program/server.js" },
  views: {},
} as const;

let counter = 0;

export async function moduleFixture(
  options: {
    readonly files?: EntryInputs;
    readonly tag?: string;
    readonly artifactId?: string;
  } = {}
) {
  counter += 1;
  const files = options.files ?? PROGRAM_FILES;
  const system = new ArtifactManager({ store: new InMemoryArtifactStore() });
  const artifact = await system.create({
    entries: files,
    freeze: { tag: options.tag ?? "1.0.0" },
    id: artifactIdSchema.parse(
      options.artifactId ?? `artifact-${String(counter)}`
    ),
    name: `Module ${String(counter)}`,
    type: MODULE_MIME,
  });
  if (!artifact.content) {
    throw new Error("Fixture requires Content");
  }
  const bytes: Record<string, Uint8Array> = {};
  for (const path of Object.keys(files)) {
    const file = await system.readFile(artifact.content.id, path);
    if (file) {
      bytes[path] = file.blob;
    }
  }
  return { artifact, bytes, content: artifact.content, files, system };
}
