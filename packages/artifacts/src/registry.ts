import type { StorageEntry } from "@foundry/core/storage";

import { HTML_MIME, isTextMime } from "@foundry/lib/mime";

import type { ARTIFACT_BASES } from "./constants";
import type { Artifact } from "./substrate";

export type ArtifactBase = (typeof ARTIFACT_BASES)[number];

export interface TypeDefinition<Handler> {
  readonly base?: ArtifactBase;
  readonly handler?: Handler;
  readonly type: string;
}

export interface RegistryTarget {
  readonly artifact: Pick<Artifact, "type">;
  readonly entry?: StorageEntry | null;
}

export interface RegistryMatch<Handler> {
  readonly base: ArtifactBase | null;
  readonly handler: Handler;
  readonly type: string;
}

export interface RegistryOptions<Handler> {
  readonly fallback: Handler;
  readonly handlers?: Partial<Readonly<Record<ArtifactBase, Handler>>>;
}

export interface Registry<Handler> {
  register(definition: TypeDefinition<Handler>): void;
  resolve(target: RegistryTarget): RegistryMatch<Handler>;
}

export function createRegistry<Handler>(
  options: RegistryOptions<Handler>
): Registry<Handler> {
  const definitions = new Map<string, TypeDefinition<Handler>>();
  const handlers = { ...options.handlers };
  const { fallback } = options;

  return {
    register(definition) {
      if (definitions.has(definition.type)) {
        throw new Error(
          `Artifact type "${definition.type}" already registered`
        );
      }
      definitions.set(definition.type, { ...definition });
    },
    resolve({ artifact, entry }) {
      const definition = definitions.get(artifact.type);
      const base =
        definition?.base ??
        recognize(artifact.type) ??
        (definition === undefined && entry?.type === "file"
          ? recognize(entry.mime)
          : null);
      return {
        base,
        handler:
          definition?.handler ??
          (base === null ? undefined : handlers[base]) ??
          fallback,
        type: artifact.type,
      };
    },
  };
}

function recognize(mime: string | null): ArtifactBase | null {
  const type = mime?.split(";", 1)[0]?.trim().toLowerCase();
  if (!type) {
    return null;
  }
  if (type === HTML_MIME || type.endsWith("+html")) {
    return "html";
  }
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  if (type === "application/json" || type.endsWith("+json")) {
    return "structured";
  }
  return isTextMime(type) ? "text" : null;
}
