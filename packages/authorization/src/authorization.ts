import type { CommitEffects } from "@foundry/core/storage";
import { canonicalizeJson } from "@foundry/lib/json";
import { Turns } from "@foundry/lib/turns";
import {
  AuthorizationDeniedError,
  AuthorizationNotFoundError,
  AuthorizationRevisionError,
  AuthorizationStateError,
  AuthorizationValidationError,
} from "./errors";
import {
  evaluateRequestAgainstGrants,
  findBlockingDenyForGrantScope,
  isExpired,
  restrictionMatchesGrantPath,
  samePrincipalIdentity,
  scopeFromRequest,
  validateGrantForReplay,
  walkDelegationAncestors,
} from "./evaluation";
import { createPermit, type Permit } from "./permit";
import type {
  AddRestrictionInput,
  ApproveGrantInput,
  AuthorizationEvent,
  AuthorizationReceipt,
  AuthorizeOptions,
  Decision,
  DenyGrantInput,
  Grant,
  GrantApproval,
  GrantId,
  GrantQuery,
  GrantState,
  InvocationClaim,
  IssueGrantInput,
  LiftRestrictionOptions,
  RequestGrantInput,
  Restriction,
  RestrictionId,
  RevocationTarget,
  RevokeOptions,
} from "./schema";
import {
  grantId as asGrantId,
  restrictionId as asRestrictionId,
} from "./schema";
import type {
  AccessRequest,
  NarrowOptions,
  Principal,
  PrincipalMatcher,
  Scope,
} from "./scope";
import { matchesPrincipal, narrows } from "./scope";
import type {
  AuthorizationStore,
  AuthorizationStoreDurability,
} from "./store/index";

export type Outcome =
  | { readonly kind: "permitted"; readonly permit: Permit }
  | { readonly grant: Grant; readonly kind: "pending" }
  | {
      readonly kind: "denied";
      readonly reason: string;
      readonly restrictionId?: RestrictionId;
    };

export interface AuthorizationOptions {
  readonly clock?: () => number;
  readonly isNarrowerDigest?: NarrowOptions["isNarrowerDigest"];
  readonly store: AuthorizationStore;
}

const REENTRY =
  "Authorization store does not provide transaction(); concurrent calls were serialized";

interface EventHub {
  readonly observers: Set<(event: AuthorizationEvent) => void>;
  readonly permitHandlers: Set<(event: AuthorizationEvent) => void>;
}

interface InternalBinding {
  readonly defaultEffects?: CommitEffects;
  readonly hub: EventHub;
}

type AuthorizationTransactionResult =
  | {
      readonly events: readonly AuthorizationEvent[];
      readonly kind: "permitted";
      readonly receipt: AuthorizationReceipt;
    }
  | {
      readonly events: readonly AuthorizationEvent[];
      readonly grant: Grant;
      readonly kind: "pending";
    }
  | {
      readonly events: readonly AuthorizationEvent[];
      readonly kind: "denied";
      readonly reason: string;
      readonly restrictionId?: RestrictionId;
    };

export class Authorization {
  readonly durability: AuthorizationStoreDurability;
  readonly #store: AuthorizationStore;
  readonly #clock: () => number;
  readonly #narrowOptions?: NarrowOptions;
  readonly #hub: EventHub;
  readonly #defaultEffects?: CommitEffects;
  readonly #turns = new Turns(REENTRY);

  constructor(options: AuthorizationOptions, binding?: InternalBinding) {
    this.#store = options.store;
    this.durability = options.store.durability ?? "commit";
    this.#clock = options.clock ?? (() => Date.now());
    if (options.isNarrowerDigest !== undefined) {
      this.#narrowOptions = { isNarrowerDigest: options.isNarrowerDigest };
    }
    this.#hub = binding?.hub ?? {
      observers: new Set(),
      permitHandlers: new Set(),
    };
    this.#defaultEffects = binding?.defaultEffects;
  }

  within(store: AuthorizationStore, effects?: CommitEffects): Authorization {
    return new Authorization(
      {
        clock: this.#clock,
        ...(this.#narrowOptions === undefined
          ? {}
          : { isNarrowerDigest: this.#narrowOptions.isNarrowerDigest }),
        store,
      },
      {
        ...(effects === undefined ? {} : { defaultEffects: effects }),
        hub: this.#hub,
      }
    );
  }

  async check(request: AccessRequest): Promise<Decision> {
    const now = this.#clock();
    const { grants, restrictions } = await this.#inTransaction(async (view) => {
      const [loadedGrants, loadedRestrictions] = await Promise.all([
        view.listGrants(),
        view.listRestrictions(),
      ]);
      return { grants: loadedGrants, restrictions: loadedRestrictions };
    });
    const result = evaluateRequestAgainstGrants(
      request,
      grants,
      restrictions,
      now,
      request.invocationId
    );
    if (result.selected !== undefined) {
      return {
        grantId: result.selected.grant.id,
        grantPath: result.selected.grantPath,
        kind: "allow",
      };
    }
    if (result.blockedByDeny !== undefined) {
      return {
        kind: "deny",
        reason: result.blockedByDeny.reason,
        restrictionId: result.blockedByDeny.id,
      };
    }
    if (result.blockedByDirectGrant !== undefined) {
      return {
        kind: "ask",
        reason: result.blockedByDirectGrant.reason,
        restrictionId: result.blockedByDirectGrant.id,
      };
    }
    return {
      kind: "ask",
      reason: "No active grant covers request",
    };
  }

  async authorize(
    request: AccessRequest,
    invocationId: string,
    options: AuthorizeOptions = {}
  ): Promise<Outcome> {
    assertNonEmptyText(invocationId, "invocationId");
    const effects = this.#resolveEffects(options.effects);
    if (options.signal?.aborted) {
      return { kind: "denied", reason: "Authorization signal already aborted" };
    }

    const buffered: AuthorizationEvent[] = [];
    let liveHandler: ((event: AuthorizationEvent) => void) | null = null;
    const collector = (event: AuthorizationEvent): void => {
      if (liveHandler === null) {
        buffered.push(event);
      } else {
        liveHandler(event);
      }
    };
    this.#hub.permitHandlers.add(collector);

    let outcome: AuthorizationTransactionResult;
    try {
      outcome = await this.#inTransaction((view) =>
        this.#authorizeInTransaction(view, request, invocationId, options)
      );
    } catch (error) {
      this.#hub.permitHandlers.delete(collector);
      throw error;
    }

    if (outcome.kind !== "permitted") {
      this.#hub.permitHandlers.delete(collector);
      this.#scheduleEvents(outcome.events, effects);
      return outcome.kind === "pending"
        ? { grant: outcome.grant, kind: "pending" }
        : {
            kind: "denied",
            reason: outcome.reason,
            ...(outcome.restrictionId === undefined
              ? {}
              : { restrictionId: outcome.restrictionId }),
          };
    }

    const { permit, activate } = this.#bindLivePermit(
      outcome.receipt,
      request,
      options.signal,
      collector
    );
    liveHandler = activate(buffered);
    this.#scheduleEvents(outcome.events, effects);
    return { kind: "permitted", permit };
  }

  async request(input: RequestGrantInput): Promise<Grant> {
    const effects = this.#resolveEffects(input.effects);
    validateScope(input.scope);
    const requiredApprovals = input.requiredApprovals ?? 1;
    assertPositiveInteger(requiredApprovals, "requiredApprovals");
    validateGrantBounds(input);

    const now = this.#clock();
    const { grant, created } = await this.#inTransaction(async (view) => {
      const [grants, restrictions] = await Promise.all([
        view.listGrants(),
        view.listRestrictions(),
      ]);
      const blocking = findBlockingDenyForGrantScope(
        input.holder,
        input.scope,
        new Set(),
        restrictions,
        this.#narrowOptions
      );
      if (blocking !== undefined) {
        throw new AuthorizationDeniedError(blocking.reason, blocking.id);
      }
      if (input.invocationId !== undefined) {
        const existing = grants.find(
          (item) =>
            item.invocationId === input.invocationId && item.state === "pending"
        );
        if (existing !== undefined) {
          return { created: false, grant: existing };
        }
      }
      assertUnusedGrantId(input.id, grants);
      const createdGrant = buildGrant({
        canDelegate: input.canDelegate ?? false,
        expiresAt: input.expiresAt,
        holder: input.holder,
        id: input.id,
        invocationId: input.invocationId,
        issuanceKey: input.issuanceKey,
        now,
        parentIds: [],
        reason: input.reason,
        requestedBy: input.requestedBy,
        requiredApprovals,
        scope: input.scope,
        sessionId: input.sessionId,
        state: "pending",
        usesRemaining: input.usesRemaining,
      });
      await view.commit({ putGrants: [createdGrant] });
      return { created: true, grant: createdGrant };
    });

    if (created) {
      this.#scheduleEvents(
        [{ at: now, grant, type: "grant.requested" }],
        effects
      );
    }
    return grant;
  }

  async grant(input: IssueGrantInput): Promise<Grant> {
    const effects = this.#resolveEffects(input.effects);
    validateScope(input.scope);
    validateGrantBounds(input);

    const now = this.#clock();
    const parentIds = uniqueIds(input.parentIds ?? []);
    const { grant, created } = await this.#inTransaction(async (view) => {
      const [grants, restrictions] = await Promise.all([
        view.listGrants(),
        view.listRestrictions(),
      ]);
      if (input.issuanceKey !== undefined) {
        const duplicate = findIdempotentIssuance(
          grants,
          input.issuanceKey,
          input.holder,
          input.scope,
          parentIds,
          input.sessionId
        );
        if (duplicate !== undefined) {
          return { created: false, grant: duplicate };
        }
      }
      assertUnusedGrantId(input.id, grants);
      const grantMap = new Map(grants.map((item) => [item.id, item]));
      const ancestors = this.#validateParentDelegations(
        parentIds,
        grantMap,
        input,
        now
      );
      const blocking = findBlockingDenyForGrantScope(
        input.holder,
        input.scope,
        ancestors,
        restrictions,
        this.#narrowOptions
      );
      if (blocking !== undefined) {
        throw new AuthorizationDeniedError(blocking.reason, blocking.id);
      }
      const issued = buildGrant({
        canDelegate: input.canDelegate ?? false,
        expiresAt: input.expiresAt,
        holder: input.holder,
        id: input.id,
        issuanceKey: input.issuanceKey,
        now,
        parentIds,
        reason: input.reason,
        requestedBy: input.requestedBy,
        requiredApprovals: 1,
        scope: input.scope,
        sessionId: input.sessionId,
        state: "active",
        usesRemaining: input.usesRemaining,
      });
      await view.commit({ putGrants: [issued] });
      return { created: true, grant: issued };
    });

    if (created) {
      this.#scheduleEvents([{ at: now, grant, type: "grant.issued" }], effects);
    }
    return grant;
  }

  async approve(grantId: GrantId, input: ApproveGrantInput): Promise<Grant> {
    const effects = this.#resolveEffects(input.effects);
    if (input.scope !== undefined) {
      validateScope(input.scope);
    }
    validateGrantBounds(input);

    const now = this.#clock();
    const { updated, approval } = await this.#inTransaction(async (view) => {
      const [grants, restrictions] = await Promise.all([
        view.listGrants(),
        view.listRestrictions(),
      ]);
      const grantMap = new Map(grants.map((item) => [item.id, item]));
      const existing = grantMap.get(grantId);
      if (existing === undefined) {
        throw new AuthorizationNotFoundError("grant", grantId);
      }
      const prepared = this.#prepareApproval(
        existing,
        input,
        grantMap,
        restrictions,
        now
      );
      await view.commit({ putGrants: [prepared.updated] });
      return prepared;
    });

    this.#scheduleEvents(
      [{ approval, at: now, grant: updated, type: "grant.approved" }],
      effects
    );
    return updated;
  }

  async deny(grantId: GrantId, input: DenyGrantInput): Promise<Grant> {
    const effects = this.#resolveEffects(input.effects);
    assertNonEmptyText(input.reason, "reason");
    const now = this.#clock();
    const updated = await this.#inTransaction(async (view) => {
      const existing = await view.getGrant(grantId);
      if (existing === null) {
        throw new AuthorizationNotFoundError("grant", grantId);
      }
      if (existing.state !== "pending") {
        throw new AuthorizationStateError(
          `Cannot deny grant ${grantId} in state ${existing.state}`
        );
      }
      const denied: Grant = {
        ...existing,
        deniedBy: {
          approver: input.approver,
          at: now,
          reason: input.reason,
        },
        revision: existing.revision + 1,
        state: "denied",
        updatedAt: now,
      };
      await view.commit({ putGrants: [denied] });
      return denied;
    });

    this.#scheduleEvents(
      [{ at: now, grant: updated, type: "grant.denied" }],
      effects
    );
    return updated;
  }

  async revoke(
    target: RevocationTarget,
    reasonOrOptions?: string | RevokeOptions
  ): Promise<readonly GrantId[]> {
    const options =
      typeof reasonOrOptions === "string"
        ? { reason: reasonOrOptions }
        : (reasonOrOptions ?? {});
    const effects = this.#resolveEffects(options.effects);

    const now = this.#clock();
    const revokedIds = await this.#inTransaction(async (view) => {
      const matched = await selectRevocationTargets(view, target);
      if (matched.length === 0) {
        return [];
      }
      const updated = matched.map(
        (grant): Grant => ({
          ...grant,
          revision: grant.revision + 1,
          revokedAt: now,
          ...(options.reason === undefined
            ? {}
            : { revokedReason: options.reason }),
          state: "revoked",
          updatedAt: now,
        })
      );
      await view.commit({ putGrants: updated });
      return updated.map((grant) => grant.id);
    });

    if (revokedIds.length > 0) {
      this.#scheduleEvents(
        [
          {
            at: now,
            grantIds: revokedIds,
            ...(options.reason === undefined ? {} : { reason: options.reason }),
            type: "grant.revoked",
          },
        ],
        effects
      );
    }
    return revokedIds;
  }

  async restrict(input: AddRestrictionInput): Promise<Restriction> {
    const effects = this.#resolveEffects(input.effects);
    validateScope(input.scope);
    assertNonEmptyText(input.reason, "reason");
    const now = this.#clock();
    const restriction: Restriction = {
      ...(input.appliesUnder === undefined
        ? {}
        : { appliesUnder: input.appliesUnder }),
      createdAt: now,
      ...(input.holder === undefined ? {} : { holder: input.holder }),
      id: input.id ?? nextRestrictionId(),
      kind: input.kind,
      reason: input.reason,
      revision: 1,
      scope: input.scope,
      updatedAt: now,
    };

    await this.#inTransaction(async (view) => {
      if (
        input.id !== undefined &&
        (await view.getRestriction(input.id)) !== null
      ) {
        throw new AuthorizationValidationError(
          `Restriction id ${input.id} already exists`
        );
      }
      await view.commit({ putRestrictions: [restriction] });
    });

    this.#scheduleEvents(
      [{ at: now, restriction, type: "restriction.added" }],
      effects
    );
    return restriction;
  }

  async liftRestriction(
    id: RestrictionId,
    options: LiftRestrictionOptions = {}
  ): Promise<void> {
    const effects = this.#resolveEffects(options.effects);
    const now = this.#clock();
    const existed = await this.#inTransaction(async (view) => {
      const existing = await view.getRestriction(id);
      if (existing === null) {
        return false;
      }
      await view.commit({ deleteRestrictions: [id] });
      return true;
    });

    if (existed) {
      this.#scheduleEvents(
        [{ at: now, restrictionId: id, type: "restriction.lifted" }],
        effects
      );
    }
  }

  getGrant(id: GrantId): Promise<Grant | null> {
    return this.#store.getGrant(id);
  }

  listGrants(query?: GrantQuery): Promise<readonly Grant[]> {
    return this.#store.listGrants(query);
  }

  listRestrictions(): Promise<readonly Restriction[]> {
    return this.#store.listRestrictions();
  }

  watch(listener: (event: AuthorizationEvent) => void): () => void {
    this.#hub.observers.add(listener);
    return () => {
      this.#hub.observers.delete(listener);
    };
  }

  async #authorizeInTransaction(
    view: AuthorizationStore,
    request: AccessRequest,
    invocationId: string,
    options: AuthorizeOptions
  ): Promise<AuthorizationTransactionResult> {
    const now = this.#clock();
    const [grants, restrictions, existingClaim] = await Promise.all([
      view.listGrants(),
      view.listRestrictions(),
      view.getClaim(invocationId),
    ]);

    if (existingClaim !== null) {
      return this.#handleExistingClaim(
        existingClaim,
        request,
        grants,
        restrictions,
        now,
        options
      );
    }

    const evaluation = evaluateRequestAgainstGrants(
      request,
      grants,
      restrictions,
      now,
      invocationId
    );
    if (evaluation.selected !== undefined) {
      return await this.#claimSelectedGrant(
        view,
        grants,
        evaluation.selected.grant,
        evaluation.selected.grantPath,
        invocationId,
        now
      );
    }
    if (evaluation.blockedByDeny !== undefined) {
      return {
        events: [],
        kind: "denied",
        reason: evaluation.blockedByDeny.reason,
        restrictionId: evaluation.blockedByDeny.id,
      };
    }
    if (options.openPending === false) {
      return {
        events: [],
        kind: "denied",
        reason:
          evaluation.blockedByDirectGrant?.reason ??
          "No active grant covers request",
        ...(evaluation.blockedByDirectGrant === undefined
          ? {}
          : { restrictionId: evaluation.blockedByDirectGrant.id }),
      };
    }
    return await this.#openOrReusePending(
      view,
      grants,
      request,
      invocationId,
      now,
      options
    );
  }

  #handleExistingClaim(
    claim: InvocationClaim,
    request: AccessRequest,
    grants: readonly Grant[],
    restrictions: readonly Restriction[],
    now: number,
    options: AuthorizeOptions
  ): AuthorizationTransactionResult {
    if (options.idempotent !== true) {
      return {
        events: [],
        kind: "denied",
        reason: `Invocation ${claim.invocationId} has already been claimed`,
      };
    }
    const grant = grants.find((item) => item.id === claim.grantId);
    if (grant === undefined) {
      return {
        events: [],
        kind: "denied",
        reason: `Claimed grant ${claim.grantId} no longer exists`,
      };
    }
    const grantPath = validateGrantForReplay(
      grant,
      request,
      grants,
      restrictions,
      now,
      claim.invocationId
    );
    if (grantPath === null) {
      return {
        events: [],
        kind: "denied",
        reason: `Claimed grant ${claim.grantId} is no longer valid for request`,
      };
    }
    return {
      events: [],
      kind: "permitted",
      receipt: {
        grantId: grant.id,
        grantPath,
        invocationId: claim.invocationId,
        issuedAt: now,
      },
    };
  }

  async #claimSelectedGrant(
    view: AuthorizationStore,
    grants: readonly Grant[],
    selected: Grant,
    grantPath: readonly GrantId[],
    invocationId: string,
    now: number
  ): Promise<AuthorizationTransactionResult> {
    const claim: InvocationClaim = {
      claimedAt: now,
      grantId: selected.id,
      invocationId,
    };
    const grantMap = new Map(grants.map((item) => [item.id, item]));
    const updatedGrants: Grant[] = [];
    const events: AuthorizationEvent[] = [];

    for (const id of uniqueIds(grantPath)) {
      const member = grantMap.get(id);
      if (member === undefined || member.usesRemaining === undefined) {
        continue;
      }
      const remaining = member.usesRemaining - 1;
      updatedGrants.push({
        ...member,
        revision: member.revision + 1,
        state: remaining === 0 ? "exhausted" : "active",
        updatedAt: now,
        usesRemaining: remaining,
      });
      events.push({
        at: now,
        grantId: member.id,
        invocationId,
        type: "grant.consumed",
        usesRemaining: remaining,
      });
    }

    if (selected.usesRemaining === undefined) {
      events.unshift({
        at: now,
        grantId: selected.id,
        invocationId,
        type: "grant.consumed",
      });
    }

    await view.commit({
      putClaims: [claim],
      ...(updatedGrants.length === 0 ? {} : { putGrants: updatedGrants }),
    });

    return {
      events,
      kind: "permitted",
      receipt: {
        grantId: selected.id,
        grantPath,
        invocationId,
        issuedAt: now,
      },
    };
  }

  async #openOrReusePending(
    view: AuthorizationStore,
    grants: readonly Grant[],
    request: AccessRequest,
    invocationId: string,
    now: number,
    options: AuthorizeOptions
  ): Promise<AuthorizationTransactionResult> {
    const existingPending = grants.find(
      (item) => item.invocationId === invocationId && item.state === "pending"
    );
    if (existingPending !== undefined) {
      return { events: [], grant: existingPending, kind: "pending" };
    }
    const existingTerminal = grants.find(
      (item) =>
        item.invocationId === invocationId &&
        (item.state === "denied" || item.state === "revoked")
    );
    if (existingTerminal !== undefined) {
      return {
        events: [],
        kind: "denied",
        reason:
          existingTerminal.state === "denied"
            ? (existingTerminal.deniedBy?.reason ?? "Grant request was denied")
            : (existingTerminal.revokedReason ?? "Grant was revoked"),
      };
    }
    const scope = scopeFromRequest(request);
    if (scope === null) {
      return {
        events: [],
        kind: "denied",
        reason: "Non-primitive request attributes require a constraintsDigest",
      };
    }
    const pendingGrant = buildGrant({
      canDelegate: false,
      holder: {
        kind: "exact",
        principal: exactPrincipalRef(request.principal),
      },
      invocationId,
      now,
      parentIds: [],
      reason: options.reason,
      requestedBy: request.principal,
      requiredApprovals: 1,
      scope,
      sessionId: request.sessionId,
      state: "pending",
    });
    await view.commit({ putGrants: [pendingGrant] });
    return {
      events: [{ at: now, grant: pendingGrant, type: "grant.requested" }],
      grant: pendingGrant,
      kind: "pending",
    };
  }

  #validateParentDelegations(
    parentIds: readonly GrantId[],
    grantMap: ReadonlyMap<GrantId, Grant>,
    input: IssueGrantInput,
    now: number
  ): ReadonlySet<GrantId> {
    if (parentIds.length === 0) {
      return new Set();
    }
    const ancestorOrder = walkDelegationAncestors(parentIds, grantMap, now, {
      sessionId: input.sessionId,
    });
    if (ancestorOrder === null) {
      throw new AuthorizationStateError(
        "Parent grant chain is missing, inactive, expired, non-delegable, or cyclic"
      );
    }
    for (const parentId of parentIds) {
      const parent = grantMap.get(parentId);
      if (parent === undefined) {
        throw new AuthorizationNotFoundError("grant", parentId);
      }
      if (
        input.issuer !== undefined &&
        !matchesPrincipal(parent.holder, input.issuer, "allow")
      ) {
        throw new AuthorizationStateError(
          `Issuer does not hold parent grant ${parentId}`
        );
      }
      this.#assertNarrowsParent(parent, {
        expiresAt: input.expiresAt,
        scope: input.scope,
        sessionId: input.sessionId,
        usesRemaining: input.usesRemaining,
      });
    }
    return new Set(ancestorOrder);
  }

  #prepareApproval(
    existing: Grant,
    input: ApproveGrantInput,
    grantMap: ReadonlyMap<GrantId, Grant>,
    restrictions: readonly Restriction[],
    now: number
  ): { readonly approval: GrantApproval; readonly updated: Grant } {
    if (existing.state !== "pending") {
      throw new AuthorizationStateError(
        `Cannot approve grant ${existing.id} in state ${existing.state}`
      );
    }
    if (isExpired(existing, now)) {
      throw new AuthorizationStateError(`Grant ${existing.id} has expired`);
    }
    if (
      input.allowSelfApproval !== true &&
      samePrincipalIdentity(input.approver, existing.requestedBy)
    ) {
      throw new AuthorizationStateError("Self-approval is not permitted");
    }
    if (
      existing.approvals.some((entry) =>
        samePrincipalIdentity(entry.approver, input.approver)
      )
    ) {
      throw new AuthorizationStateError(
        `Approver ${input.approver.kind}:${input.approver.id} has already approved grant ${existing.id}`
      );
    }
    const tightened = this.#tightenPendingGrant(existing, input);
    const parentIds = uniqueIds([
      ...existing.parentIds,
      ...(input.parentGrantId === undefined ? [] : [input.parentGrantId]),
    ]);
    const ancestors = this.#verifyApproverAuthority(
      input,
      tightened,
      parentIds,
      existing.invocationId,
      grantMap,
      now
    );
    const blocking = findBlockingDenyForGrantScope(
      existing.holder,
      tightened.scope,
      ancestors,
      restrictions,
      this.#narrowOptions
    );
    if (blocking !== undefined) {
      throw new AuthorizationDeniedError(blocking.reason, blocking.id);
    }
    const approval: GrantApproval = {
      approver: input.approver,
      at: now,
      ...(input.parentGrantId === undefined
        ? {}
        : { parentGrantId: input.parentGrantId }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    const nextApprovals = [...existing.approvals, approval];
    const activated = nextApprovals.length >= existing.requiredApprovals;
    const updated: Grant = {
      ...existing,
      approvals: nextApprovals,
      canDelegate: tightened.canDelegate,
      ...(tightened.expiresAt === undefined
        ? {}
        : { expiresAt: tightened.expiresAt }),
      parentIds,
      revision: existing.revision + 1,
      scope: tightened.scope,
      ...(tightened.sessionId === undefined
        ? {}
        : { sessionId: tightened.sessionId }),
      state: activated ? "active" : "pending",
      updatedAt: now,
      ...(tightened.usesRemaining === undefined
        ? {}
        : { usesRemaining: tightened.usesRemaining }),
    };
    return { approval, updated };
  }

  #tightenPendingGrant(
    existing: Grant,
    input: ApproveGrantInput
  ): TightenedGrantFields {
    const scope = input.scope ?? existing.scope;
    if (
      input.scope !== undefined &&
      !narrows(input.scope, existing.scope, this.#narrowOptions)
    ) {
      throw new AuthorizationStateError(
        "Approval scope cannot widen the requested grant scope"
      );
    }
    const expiresAt = input.expiresAt ?? existing.expiresAt;
    if (
      input.expiresAt !== undefined &&
      existing.expiresAt !== undefined &&
      input.expiresAt > existing.expiresAt
    ) {
      throw new AuthorizationStateError(
        "Approval expiresAt cannot exceed the requested grant expiration"
      );
    }
    const usesRemaining = input.usesRemaining ?? existing.usesRemaining;
    if (
      input.usesRemaining !== undefined &&
      existing.usesRemaining !== undefined &&
      input.usesRemaining > existing.usesRemaining
    ) {
      throw new AuthorizationStateError(
        "Approval usesRemaining cannot exceed the requested grant uses"
      );
    }
    const sessionId = input.sessionId ?? existing.sessionId;
    if (
      input.sessionId !== undefined &&
      existing.sessionId !== undefined &&
      input.sessionId !== existing.sessionId
    ) {
      throw new AuthorizationStateError(
        "Approval sessionId cannot change an existing session restriction"
      );
    }
    const canDelegate = input.canDelegate ?? existing.canDelegate;
    if (canDelegate && !existing.canDelegate) {
      throw new AuthorizationStateError(
        "Approval cannot enable delegation on a non-delegable grant request"
      );
    }
    return { canDelegate, expiresAt, scope, sessionId, usesRemaining };
  }

  #verifyApproverAuthority(
    input: ApproveGrantInput,
    tightened: TightenedGrantFields,
    allParentIds: readonly GrantId[],
    invocationId: string | undefined,
    grantMap: ReadonlyMap<GrantId, Grant>,
    now: number
  ): ReadonlySet<GrantId> {
    if (input.parentGrantId === undefined) {
      if (input.rootAuthority !== true) {
        throw new AuthorizationStateError(
          "Approval requires either parentGrantId or rootAuthority: true"
        );
      }
      if (allParentIds.length === 0) {
        return new Set();
      }
      const existingAncestors = walkDelegationAncestors(
        allParentIds,
        grantMap,
        now,
        { invocationId, sessionId: tightened.sessionId }
      );
      if (existingAncestors === null) {
        throw new AuthorizationStateError(
          "Existing parent grant chain is no longer active or delegable"
        );
      }
      return new Set(existingAncestors);
    }
    const parent = grantMap.get(input.parentGrantId);
    if (parent === undefined) {
      throw new AuthorizationNotFoundError("grant", input.parentGrantId);
    }
    if (!matchesPrincipal(parent.holder, input.approver, "allow")) {
      throw new AuthorizationStateError(
        `Approver does not hold parent grant ${input.parentGrantId}`
      );
    }
    const ancestors = walkDelegationAncestors(allParentIds, grantMap, now, {
      invocationId,
      sessionId: tightened.sessionId,
    });
    if (ancestors === null) {
      throw new AuthorizationStateError(
        "Approver parent grant chain is inactive, expired, non-delegable, or cyclic"
      );
    }
    this.#assertNarrowsParent(parent, tightened);
    return new Set(ancestors);
  }

  #assertNarrowsParent(
    parent: Grant,
    child: {
      readonly expiresAt?: number;
      readonly scope: Scope;
      readonly sessionId?: string;
      readonly usesRemaining?: number;
    }
  ): void {
    if (!narrows(child.scope, parent.scope, this.#narrowOptions)) {
      throw new AuthorizationStateError(
        `Child scope does not narrow parent grant ${parent.id}`
      );
    }
    if (
      parent.expiresAt !== undefined &&
      (child.expiresAt === undefined || child.expiresAt > parent.expiresAt)
    ) {
      throw new AuthorizationStateError(
        `Child expiresAt exceeds parent grant ${parent.id}`
      );
    }
    if (
      parent.usesRemaining !== undefined &&
      (child.usesRemaining === undefined ||
        child.usesRemaining > parent.usesRemaining)
    ) {
      throw new AuthorizationStateError(
        `Child usesRemaining exceeds parent grant ${parent.id}`
      );
    }
    if (
      parent.sessionId !== undefined &&
      child.sessionId !== parent.sessionId
    ) {
      throw new AuthorizationStateError(
        `Child sessionId must match parent grant ${parent.id}`
      );
    }
  }

  #bindLivePermit(
    receipt: AuthorizationReceipt,
    request: AccessRequest,
    callerSignal: AbortSignal | undefined,
    collector: (event: AuthorizationEvent) => void
  ): {
    readonly activate: (
      buffered: readonly AuthorizationEvent[]
    ) => (event: AuthorizationEvent) => void;
    readonly permit: Permit;
  } {
    const controller = new AbortController();
    const pathSet = new Set(receipt.grantPath);
    const onCallerAbort = (): void => {
      controller.abort(callerSignal?.reason);
      cleanup();
    };
    const cleanup = (): void => {
      this.#hub.permitHandlers.delete(collector);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) {
        onCallerAbort();
      } else {
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    const handleEvent = (event: AuthorizationEvent): void => {
      if (controller.signal.aborted) {
        return;
      }
      if (
        event.type === "grant.revoked" &&
        event.grantIds.some((id) => pathSet.has(id))
      ) {
        controller.abort(
          new AuthorizationDeniedError(event.reason ?? "Grant revoked")
        );
        cleanup();
        return;
      }
      if (
        event.type === "restriction.added" &&
        event.restriction.kind === "deny" &&
        restrictionMatchesGrantPath(event.restriction, request, pathSet)
      ) {
        controller.abort(
          new AuthorizationDeniedError(
            event.restriction.reason,
            event.restriction.id
          )
        );
        cleanup();
      }
    };
    const activate = (
      buffered: readonly AuthorizationEvent[]
    ): ((event: AuthorizationEvent) => void) => {
      for (const event of buffered) {
        handleEvent(event);
      }
      return handleEvent;
    };
    const permit = createPermit(receipt, controller.signal, cleanup);
    return { activate, permit };
  }

  #inTransaction<T>(
    work: (view: AuthorizationStore) => Promise<T>
  ): Promise<T> {
    if (this.#store.transaction !== undefined) {
      return this.#store.transaction(work);
    }
    return this.#turns.run(() => work(this.#store));
  }

  #resolveEffects(
    effects: CommitEffects | undefined
  ): CommitEffects | undefined {
    const resolved = effects ?? this.#defaultEffects;
    if (this.durability === "host" && resolved === undefined) {
      throw new TypeError(
        "CommitEffects are required for mutating operations when store durability is 'host'"
      );
    }
    return resolved;
  }

  #scheduleEvents(
    events: readonly AuthorizationEvent[],
    effects: CommitEffects | undefined
  ): void {
    if (events.length === 0) {
      return;
    }
    if (this.durability === "host") {
      effects?.afterCommit(async () => {
        for (const event of events) {
          this.#dispatch(event);
        }
      });
      return;
    }
    for (const event of events) {
      this.#dispatch(event);
    }
  }

  #dispatch(event: AuthorizationEvent): void {
    dispatchAll(this.#hub.permitHandlers, event);
    dispatchAll(this.#hub.observers, event);
  }
}

function dispatchAll(
  listeners: ReadonlySet<(event: AuthorizationEvent) => void>,
  event: AuthorizationEvent
): void {
  for (const listener of [...listeners]) {
    invokeSafely(listener, event);
  }
}

function invokeSafely(
  listener: (event: AuthorizationEvent) => void,
  event: AuthorizationEvent
): boolean {
  try {
    listener(event);
    return true;
  } catch {
    return false;
  }
}

interface TightenedGrantFields {
  readonly canDelegate: boolean;
  readonly expiresAt?: number;
  readonly scope: Scope;
  readonly sessionId?: string;
  readonly usesRemaining?: number;
}

interface BuildGrantFields {
  readonly canDelegate: boolean;
  readonly expiresAt?: number;
  readonly holder: PrincipalMatcher;
  readonly id?: GrantId;
  readonly invocationId?: string;
  readonly issuanceKey?: string;
  readonly now: number;
  readonly parentIds: readonly GrantId[];
  readonly reason?: string;
  readonly requestedBy: Principal;
  readonly requiredApprovals: number;
  readonly scope: Scope;
  readonly sessionId?: string;
  readonly state: GrantState;
  readonly usesRemaining?: number;
}

function buildGrant(fields: BuildGrantFields): Grant {
  return {
    approvals: [],
    canDelegate: fields.canDelegate,
    createdAt: fields.now,
    ...(fields.expiresAt === undefined ? {} : { expiresAt: fields.expiresAt }),
    holder: fields.holder,
    id: fields.id ?? nextGrantId(),
    ...(fields.invocationId === undefined
      ? {}
      : { invocationId: fields.invocationId }),
    ...(fields.issuanceKey === undefined
      ? {}
      : { issuanceKey: fields.issuanceKey }),
    parentIds: fields.parentIds,
    ...(fields.reason === undefined ? {} : { reason: fields.reason }),
    requestedBy: fields.requestedBy,
    requiredApprovals: fields.requiredApprovals,
    revision: 1,
    scope: fields.scope,
    ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
    state: fields.state,
    updatedAt: fields.now,
    ...(fields.usesRemaining === undefined
      ? {}
      : { usesRemaining: fields.usesRemaining }),
  };
}

function assertUnusedGrantId(
  id: GrantId | undefined,
  grants: readonly Grant[]
): void {
  if (id !== undefined && grants.some((item) => item.id === id)) {
    throw new AuthorizationValidationError(`Grant id ${id} already exists`);
  }
}

function validateGrantBounds(input: {
  readonly expiresAt?: number;
  readonly usesRemaining?: number;
}): void {
  if (input.usesRemaining !== undefined) {
    assertPositiveInteger(input.usesRemaining, "usesRemaining");
  }
  if (input.expiresAt !== undefined) {
    assertFiniteNumber(input.expiresAt, "expiresAt");
  }
}

async function selectRevocationTargets(
  view: AuthorizationStore,
  target: RevocationTarget
): Promise<readonly Grant[]> {
  if (target.kind === "grant") {
    const grant = await view.getGrant(target.grantId);
    if (grant === null) {
      throw new AuthorizationNotFoundError("grant", target.grantId);
    }
    if (
      target.expectedRevision !== undefined &&
      grant.revision !== target.expectedRevision
    ) {
      throw new AuthorizationRevisionError(
        grant.id,
        target.expectedRevision,
        grant.revision
      );
    }
    return isRevocableState(grant.state) ? [grant] : [];
  }
  if (target.kind === "issuance") {
    const grants = await view.listGrants({ issuanceKey: target.issuanceKey });
    return grants.filter((grant) => isRevocableState(grant.state));
  }
  if (target.kind === "session") {
    const grants = await view.listGrants({ sessionId: target.sessionId });
    return grants.filter((grant) => isRevocableState(grant.state));
  }
  const grants = await view.listGrants();
  return grants.filter(
    (grant) =>
      isRevocableState(grant.state) &&
      grant.holder.kind === "exact" &&
      grant.holder.principal.kind === target.principal.kind &&
      grant.holder.principal.id === target.principal.id &&
      (target.principal.version === undefined ||
        grant.holder.principal.version === target.principal.version)
  );
}

function isRevocableState(state: Grant["state"]): boolean {
  return state !== "revoked" && state !== "denied";
}

function findIdempotentIssuance(
  grants: readonly Grant[],
  issuanceKey: string,
  holder: PrincipalMatcher,
  scope: Scope,
  parentIds: readonly GrantId[],
  sessionId: string | undefined
): Grant | undefined {
  const fingerprint = canonicalizeJson({
    holder,
    parentIds,
    scope,
    sessionId: sessionId ?? null,
  });
  return grants.find(
    (grant) =>
      grant.issuanceKey === issuanceKey &&
      canonicalizeJson({
        holder: grant.holder,
        parentIds: grant.parentIds,
        scope: grant.scope,
        sessionId: grant.sessionId ?? null,
      }) === fingerprint
  );
}

function exactPrincipalRef(
  principal: Principal
): Pick<Principal, "kind" | "id" | "version"> {
  return {
    id: principal.id,
    kind: principal.kind,
    ...(principal.version === undefined ? {} : { version: principal.version }),
  };
}

function uniqueIds(ids: readonly GrantId[]): readonly GrantId[] {
  return [...new Set(ids)];
}

function nextGrantId(): GrantId {
  return asGrantId(`grt_${crypto.randomUUID()}`);
}

function nextRestrictionId(): RestrictionId {
  return asRestrictionId(`rst_${crypto.randomUUID()}`);
}

function assertNonEmptyText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthorizationValidationError(
      `${field} must be a non-empty string`
    );
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AuthorizationValidationError(
      `${field} must be a positive safe integer`
    );
  }
}

function assertFiniteNumber(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AuthorizationValidationError(`${field} must be a finite number`);
  }
}

function validateScope(scope: Scope): void {
  assertNonEmptyText(scope.action, "scope.action");
}
