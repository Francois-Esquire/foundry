import { Authorization as AuthorizationControlPlane } from "./authorization";
import {
  AuthorizationError as BaseAuthorizationError,
  AuthorizationDeniedError as DeniedError,
  AuthorizationNotFoundError as NotFoundError,
  AuthorizationPendingError as PendingError,
  AuthorizationRevisionError as RevisionError,
  AuthorizationStateError as StateError,
  AuthorizationValidationError as ValidationError,
} from "./errors";
import { Permit as PermitHandle } from "./permit";
import {
  type AuthorizeOptions,
  grantId as asGrantId,
  restrictionId as asRestrictionId,
} from "./schema";
import {
  type AccessRequest,
  covers as coversImpl,
  matchesPrincipal as matchesPrincipalImpl,
  narrows as narrowsImpl,
} from "./scope";

export type { AuthorizationOptions, Outcome } from "./authorization";
export type { AuthorizationErrorCode } from "./errors";
export type {
  AddRestrictionInput,
  ApproveGrantInput,
  AuthorizationEvent,
  AuthorizationReceipt,
  AuthorizeOptions,
  Decision,
  DenyGrantInput,
  Grant,
  GrantApproval,
  GrantDenial,
  GrantId,
  GrantQuery,
  GrantState,
  InvocationClaim,
  IssueGrantInput,
  LiftRestrictionOptions,
  RequestGrantInput,
  Restriction,
  RestrictionId,
  RestrictionKind,
  RevocationTarget,
  RevokeOptions,
} from "./schema";
export type {
  AccessRequest,
  ConstraintBound,
  JsonPrimitive,
  MatchMode,
  NarrowOptions,
  Principal,
  PrincipalMatcher,
  Scope,
  ScopeMatcher,
} from "./scope";

export type Authorization = AuthorizationControlPlane;
export const Authorization = AuthorizationControlPlane;
export type AuthorizationError = BaseAuthorizationError;
export const AuthorizationError = BaseAuthorizationError;
export type AuthorizationDeniedError = DeniedError;
export const AuthorizationDeniedError = DeniedError;
export type AuthorizationPendingError = PendingError;
export const AuthorizationPendingError = PendingError;
export type AuthorizationNotFoundError = NotFoundError;
export const AuthorizationNotFoundError = NotFoundError;
export type AuthorizationStateError = StateError;
export const AuthorizationStateError = StateError;
export type AuthorizationRevisionError = RevisionError;
export const AuthorizationRevisionError = RevisionError;
export type AuthorizationValidationError = ValidationError;
export const AuthorizationValidationError = ValidationError;
export type Permit = PermitHandle;
export const Permit = PermitHandle;
export const grantId = asGrantId;
export const restrictionId = asRestrictionId;
export const covers = coversImpl;
export const matchesPrincipal = matchesPrincipalImpl;
export const narrows = narrowsImpl;

export async function withPermit<T>(
  authorization: Authorization,
  request: AccessRequest,
  invocationId: string,
  work: (permit: Permit) => Promise<T>,
  options?: AuthorizeOptions
): Promise<T> {
  const outcome = await authorization.authorize(request, invocationId, options);
  if (outcome.kind === "denied") {
    throw new AuthorizationDeniedError(outcome.reason, outcome.restrictionId);
  }
  if (outcome.kind === "pending") {
    throw new AuthorizationPendingError(outcome.grant);
  }
  try {
    if (outcome.permit.signal.aborted) {
      throw outcome.permit.signal.reason;
    }
    return await work(outcome.permit);
  } finally {
    outcome.permit.release();
  }
}
