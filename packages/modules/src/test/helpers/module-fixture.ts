import type { EntryInputs, FileInputs } from "@foundry/artifacts";

import { Artifacts, artifactIdSchema } from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";

import { MODULE_MIME } from "../../domain";

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

export const STRICT_MANIFEST = {
  capabilities: [],
  compatibility: { gateway: "1", runtime: "bun@1" },
  editors: [
    { mimeTypes: ["text/plain", "text/markdown"], mode: "write", view: "edit" },
  ],
  format: "foundry.module-manifest/1",
  network: {
    destinations: [{ host: "api.example.com", ports: [443] }],
    reason: "Loads forecasts",
  },
  persistence: { files: "installation" },
  program: { entry: "outputs/program/server.js" },
  resources: { cpus: 1, memoryBytes: 268_435_456 },
  settings: {
    "authoring.maxSteps": { default: 10 },
    "queues.workflows.concurrency": { default: 2, minimum: 1 },
  },
  views: { edit: { path: "/edit" }, home: { path: "/" } },
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
  const system = new Artifacts({ store: new MemoryArtifactStore() });
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
