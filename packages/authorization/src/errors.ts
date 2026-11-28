import type { Grant, GrantId, RestrictionId } from "./schema";

const AUTHORIZATION_ERROR_CODES = [
  "denied",
  "pending",
  "not_found",
  "invalid_state",
  "revision_conflict",
  "validation",
] as const;

export type AuthorizationErrorCode = (typeof AUTHORIZATION_ERROR_CODES)[number];

export class AuthorizationError extends Error {
  override readonly name: string = "AuthorizationError";
  readonly code: AuthorizationErrorCode;

  constructor(code: AuthorizationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class AuthorizationDeniedError extends AuthorizationError {
  override readonly name = "AuthorizationDeniedError";
  readonly reason: string;
  readonly restrictionId?: RestrictionId;

  constructor(reason: string, restrictionId?: RestrictionId) {
    super("denied", reason);
    this.reason = reason;
    if (restrictionId !== undefined) {
      this.restrictionId = restrictionId;
    }
  }
}

export class AuthorizationPendingError extends AuthorizationError {
  override readonly name = "AuthorizationPendingError";
  readonly grant: Grant;

  constructor(grant: Grant) {
    super("pending", `Authorization pending approval for grant ${grant.id}`);
    this.grant = grant;
  }
}

export class AuthorizationNotFoundError extends AuthorizationError {
  override readonly name = "AuthorizationNotFoundError";
  readonly resourceId: string;

  constructor(resourceKind: "grant" | "restriction", resourceId: string) {
    super("not_found", `${resourceKind} ${resourceId} was not found`);
    this.resourceId = resourceId;
  }
}

export class AuthorizationStateError extends AuthorizationError {
  override readonly name = "AuthorizationStateError";

  constructor(message: string) {
    super("invalid_state", message);
  }
}

export class AuthorizationRevisionError extends AuthorizationError {
  override readonly name = "AuthorizationRevisionError";
  readonly grantId: GrantId;
  readonly expectedRevision: number;
  readonly actualRevision: number | null;

  constructor(
    grantId: GrantId,
    expectedRevision: number,
    actualRevision: number | null
  ) {
    super(
      "revision_conflict",
      actualRevision === null
        ? `Grant ${grantId} revision conflict: expected ${expectedRevision}, grant not found`
        : `Grant ${grantId} revision conflict: expected ${expectedRevision}, got ${actualRevision}`
    );
    this.grantId = grantId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class AuthorizationValidationError extends AuthorizationError {
  override readonly name = "AuthorizationValidationError";

  constructor(message: string) {
    super("validation", message);
  }
}
