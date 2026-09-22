import { StorageApplicationError } from "@foundry/core/storage";

import type { ArtifactId, ContentId } from "./ref";

export class ArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ArtifactApplicationError extends StorageApplicationError {
  readonly artifactIds: readonly ArtifactId[];
  constructor(artifactIds: readonly ArtifactId[], options: ErrorOptions) {
    super(
      "Artifact records committed; filesystem application requires recovery",
      options
    );
    this.artifactIds = artifactIds;
  }
}

export class ArtifactNotFoundError extends ArtifactError {
  readonly artifactId: ArtifactId;
  constructor(artifactId: ArtifactId) {
    super(`[artifacts] Artifact "${artifactId}" was not found`);
    this.artifactId = artifactId;
  }
}

export class ContentNotFoundError extends ArtifactError {
  readonly contentId: ContentId;
  constructor(contentId: ContentId) {
    super(`[artifacts] Content "${contentId}" was not found`);
    this.contentId = contentId;
  }
}

export class ArtifactExistsError extends ArtifactError {
  readonly artifactId: ArtifactId;
  constructor(artifactId: ArtifactId) {
    super(`[artifacts] Artifact "${artifactId}" already exists`);
    this.artifactId = artifactId;
  }
}

export class StaleContentError extends ArtifactError {
  readonly artifactId: ArtifactId;
  readonly current: {
    readonly contentId: ContentId | null;
    readonly updatedAt: Date | null;
  };
  constructor(
    artifactId: ArtifactId,
    current: {
      readonly contentId: ContentId | null;
      readonly updatedAt: Date | null;
    }
  ) {
    super(`[artifacts] Artifact "${artifactId}" changed under the write`);
    this.artifactId = artifactId;
    this.current = current;
  }
}

export class DuplicateTagError extends ArtifactError {
  readonly artifactId: ArtifactId;
  readonly tag: string;
  constructor(artifactId: ArtifactId, tag: string) {
    super(
      `[artifacts] Artifact "${artifactId}" already has a Content tagged "${tag}"`
    );
    this.artifactId = artifactId;
    this.tag = tag;
  }
}

export class ArtifactInUseError extends ArtifactError {
  readonly artifactId: ArtifactId;
  constructor(artifactId: ArtifactId) {
    super(
      `[artifacts] Artifact "${artifactId}" is pinned and cannot be deleted`
    );
    this.artifactId = artifactId;
  }
}

export class ContentInUseError extends ArtifactError {
  readonly contentId: ContentId;
  constructor(contentId: ContentId) {
    super(`[artifacts] Content "${contentId}" is pinned and cannot be deleted`);
    this.contentId = contentId;
  }
}

export class ContentStateError extends ArtifactError {
  readonly contentId: ContentId;
  readonly state: string;
  readonly operation: string;
  constructor(contentId: ContentId, state: string, operation: string) {
    super(
      `[artifacts] Content "${contentId}" is ${state}; cannot ${operation}`
    );
    this.contentId = contentId;
    this.state = state;
    this.operation = operation;
  }
}

export class InvalidArtifactInputError extends ArtifactError {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`[artifacts] invalid ${field}: ${reason}`);
    this.field = field;
  }
}

export class FilePointerError extends ArtifactError {
  readonly key: string;
  readonly path: string;
  constructor(key: string, path: string) {
    super(`[artifacts] metadata.${key} points at "${path}", not in the tree`);
    this.key = key;
    this.path = path;
  }
}

export class FileTooLargeError extends ArtifactError {
  readonly path: string | null;
  readonly bytes: number;
  readonly limit: number;
  constructor(path: string | null, bytes: number, limit: number) {
    super(
      path === null
        ? `[artifacts] tree is ${String(bytes)} bytes; limit ${String(limit)}`
        : `[artifacts] "${path}" is ${String(bytes)} bytes; limit ${String(limit)}`
    );
    this.path = path;
    this.bytes = bytes;
    this.limit = limit;
  }
}
