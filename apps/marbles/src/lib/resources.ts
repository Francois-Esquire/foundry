export type ResourceKind = "run" | "session" | "artifact" | "sandbox";

export interface ResourceRef {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly owner: string;
}

export class ResourceNotFoundError extends Error {
  override readonly name = "ResourceNotFoundError";
}
