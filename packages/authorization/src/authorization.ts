import type { CommitEffects } from "@foundry/core/storage";
import { Turns } from "@foundry/lib/turns";
import { prepareApproval, validateParentDelegations } from "./delegation";
import {
  AuthorizationDeniedError,
  AuthorizationNotFoundError,
  AuthorizationStateError,
  AuthorizationValidationError,
} from "./errors";
import {
  evaluateRequestAgainstGrants,
  findBlockingDenyForGrantScope,
  isExpired,
  restrictionMatchesGrantPath,
  scopeFromRequest,
  validateGrantForReplay,
} from "./evaluation";
import { createEventHub, dispatchEvent, type EventHub } from "./event-hub";
import {
  assertNonEmptyText,
  assertPositiveInteger,
  assertUnusedGrantRecord,
  buildGrant,
  exactPrincipalRef,
  fingerprintRequest,
  matchesPendingGrantForRequest,
  matchesRequestFingerprint,
  reuseIdempotentIssuance,
  reusePendingRequest,
  validateGrantBounds,
  validateScope,
} from "./grant-helpers";
import {
  loadAncestorMapByIds,
  loadGrantsWithAncestors,
  selectRevocationTargets,
  uniqueIds,
} from "./grant-loader";
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
  GrantId,
  GrantQuery,
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
import type { AccessRequest, NarrowOptions } from "./scope";
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
  readonly generateId?: (prefix: "grt" | "rst") => string;
  readonly isNarrowerDigest?: NarrowOptions["isNarrowerDigest"];
  readonly store: AuthorizationStore;
}

const REENTRY =
  "Authorization store does not provide transaction(); concurrent calls were serialized";

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
  readonly #generateId: (prefix: "grt" | "rst") => string;
  readonly #narrowOptions?: NarrowOptions;
  readonly #hub: EventHub;
  readonly #defaultEffects?: CommitEffects;
  readonly #turns = new Turns(REENTRY);

  constructor(options: AuthorizationOptions, binding?: InternalBinding) {
    this.#store = options.store;
    this.durability = options.store.durability ?? "commit";
    this.#clock = options.clock ?? (() => Date.now());
    this.#generateId =
      options.generateId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
    if (options.isNarrowerDigest !== undefined) {
      this.#narrowOptions = { isNarrowerDigest: options.isNarrowerDigest };
    }
    this.#hub = binding?.hub ?? createEventHub();
    this.#defaultEffects = binding?.defaultEffects;
  }

  within(store: AuthorizationStore, effects?: CommitEffects): Authorization {
    return new Authorization(
      {
        clock: this.#clock,
        generateId: this.#generateId,
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
    const snapshot = structuredClone(request);
    const { grants, restrictions } = await this.#inTransaction(async (view) => {
      const [activeGrants, loadedRestrictions] = await Promise.all([
        view.listGrants({ action: snapshot.action, state: "active" }),
        view.listRestrictions({ action: snapshot.action }),
      ]);
      const loadedGrants = await loadGrantsWithAncestors(view, activeGrants);
      return { grants: loadedGrants, restrictions: loadedRestrictions };
    });
    const now = this.#clock();
    const result = evaluateRequestAgainstGrants(
      snapshot,
      grants,
      restrictions,
      now,
      snapshot.invocationId
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

  async verifyReceipt(
    receipt: AuthorizationReceipt,
    request: AccessRequest
  ): Promise<Decision> {
    const snapshot = structuredClone(request);
    const { claim, grant, grants, restrictions } = await this.#inTransaction(
      async (view) => {
        const [loadedClaim, loadedGrant, loadedRestrictions] =
          await Promise.all([
            view.getClaim(receipt.invocationId),
            view.getGrant(receipt.grantId),
            view.listRestrictions({ action: snapshot.action }),
          ]);
        const loadedGrants =
          loadedGrant === null
            ? []
            : await loadGrantsWithAncestors(view, [loadedGrant]);
        return {
          claim: loadedClaim,
          grant: loadedGrant,
          grants: loadedGrants,
          restrictions: loadedRestrictions,
        };
      }
    );
    if (claim === null || claim.grantId !== receipt.grantId) {
      return {
        kind: "deny",
        reason: `Invocation ${receipt.invocationId} has no matching claim for grant ${receipt.grantId}`,
      };
    }
    if (
      !(await matchesRequestFingerprint(claim.requestFingerprint, snapshot))
    ) {
      return {
        kind: "deny",
        reason: `Invocation ${receipt.invocationId} was claimed for a different request`,
      };
    }
    if (grant === null) {
      return {
        kind: "deny",
        reason: `Grant ${receipt.grantId} no longer exists`,
      };
    }
    const now = this.#clock();
    const validated = validateGrantForReplay(
      grant,
      snapshot,
      grants,
      restrictions,
      now,
      receipt.invocationId
    );
    if (validated.blockedByDeny !== undefined) {
      return {
        kind: "deny",
        reason: validated.blockedByDeny.reason,
        restrictionId: validated.blockedByDeny.id,
      };
    }
    if (validated.blockedByDirectGrant !== undefined) {
      return {
        kind: "deny",
        reason: validated.blockedByDirectGrant.reason,
        restrictionId: validated.blockedByDirectGrant.id,
      };
    }
    if (validated.grantPath === undefined) {
      return {
        kind: "deny",
        reason: `Grant ${receipt.grantId} is no longer valid for request`,
      };
    }
    if (
      receipt.grantPath.length === 0 ||
      receipt.grantPath.length !== validated.grantPath.length ||
      receipt.grantPath.some((id, index) => id !== validated.grantPath?.[index])
    ) {
      return {
        kind: "deny",
        reason: `Receipt grantPath does not match active grant chain for ${receipt.grantId}`,
      };
    }
    return {
      grantId: grant.id,
      grantPath: validated.grantPath,
      kind: "allow",
    };
  }

  async authorize(
    request: AccessRequest,
    invocationId: string,
    options: AuthorizeOptions = {}
  ): Promise<Outcome> {
    assertNonEmptyText(invocationId, "invocationId");
    if (this.durability === "host") {
      throw new AuthorizationStateError(
        "authorize() requires a commit-durable store; commit the host transaction before issuing a live permit"
      );
    }
    const effects = this.#resolveEffects(options.effects);
    if (options.signal?.aborted) {
      return { kind: "denied", reason: "Authorization signal already aborted" };
    }
    const snapshot = structuredClone(request);

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
        this.#authorizeInTransaction(view, snapshot, invocationId, options)
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
      snapshot,
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

    const { grant, created, now } = await this.#inTransaction(async (view) => {
      const [restrictions, pendingForInvocation, existingById] =
        await Promise.all([
          view.listRestrictions({ action: input.scope.action }),
          input.invocationId === undefined
            ? Promise.resolve<readonly Grant[]>([])
            : view.listGrants({
                invocationId: input.invocationId,
                state: "pending",
              }),
          input.id === undefined
            ? Promise.resolve<Grant | null>(null)
            : view.getGrant(input.id),
        ]);
      const at = this.#clock();
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
      const reused = reusePendingRequest(
        pendingForInvocation,
        input,
        requiredApprovals,
        at
      );
      if (reused !== undefined) {
        return { created: false, grant: reused, now: at };
      }
      assertUnusedGrantRecord(input.id, existingById);
      const createdGrant = buildGrant({
        canDelegate: input.canDelegate ?? false,
        expiresAt: input.expiresAt,
        holder: input.holder,
        id: input.id ?? this.#nextGrantId(),
        invocationId: input.invocationId,
        issuanceKey: input.issuanceKey,
        now: at,
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
      return { created: true, grant: createdGrant, now: at };
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

    const parentIds = uniqueIds(input.parentIds ?? []);
    const { grant, created, now } = await this.#inTransaction(async (view) => {
      const [restrictions, issuanceGrants, existingById, parentMap] =
        await Promise.all([
          view.listRestrictions({ action: input.scope.action }),
          input.issuanceKey === undefined
            ? Promise.resolve<readonly Grant[]>([])
            : view.listGrants({ issuanceKey: input.issuanceKey }),
          input.id === undefined
            ? Promise.resolve<Grant | null>(null)
            : view.getGrant(input.id),
          loadAncestorMapByIds(view, parentIds),
        ]);
      const at = this.#clock();
      const reused = reuseIdempotentIssuance(issuanceGrants, input, parentIds);
      if (reused !== undefined) {
        return { created: false, grant: reused, now: at };
      }
      assertUnusedGrantRecord(input.id, existingById);
      const ancestors = validateParentDelegations(
        parentIds,
        parentMap,
        input,
        at,
        this.#narrowOptions
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
        id: input.id ?? this.#nextGrantId(),
        issuanceKey: input.issuanceKey,
        now: at,
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
      return { created: true, grant: issued, now: at };
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

    const { updated, approval, now } = await this.#inTransaction(
      async (view) => {
        const existing = await view.getGrant(grantId);
        if (existing === null) {
          throw new AuthorizationNotFoundError("grant", grantId);
        }
        const targetAction = (input.scope ?? existing.scope).action;
        const seedParentIds = uniqueIds([
          ...existing.parentIds,
          ...(input.parentGrantId === undefined ? [] : [input.parentGrantId]),
        ]);
        const [restrictions, grantMap] = await Promise.all([
          view.listRestrictions({ action: targetAction }),
          loadAncestorMapByIds(view, seedParentIds),
        ]);
        grantMap.set(existing.id, existing);
        const at = this.#clock();
        const prepared = prepareApproval(
          existing,
          input,
          grantMap,
          restrictions,
          at,
          this.#narrowOptions
        );
        await view.commit({
          expectedGrantRevisions: { [existing.id]: existing.revision },
          putGrants: [prepared.updated],
        });
        return { ...prepared, now: at };
      }
    );

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
      await view.commit({
        expectedGrantRevisions: { [existing.id]: existing.revision },
        putGrants: [denied],
      });
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
      const expectedGrantRevisions: Record<GrantId, number> = {};
      const updated = matched.map((grant): Grant => {
        expectedGrantRevisions[grant.id] = grant.revision;
        return {
          ...grant,
          revision: grant.revision + 1,
          revokedAt: now,
          ...(options.reason === undefined
            ? {}
            : { revokedReason: options.reason }),
          state: "revoked",
          updatedAt: now,
        };
      });
      await view.commit({
        expectedGrantRevisions,
        putGrants: updated,
      });
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
      id: input.id ?? this.#nextRestrictionId(),
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
    const [activeGrants, invocationGrants, restrictions, existingClaim] =
      await Promise.all([
        view.listGrants({ action: request.action, state: "active" }),
        view.listGrants({ invocationId }),
        view.listRestrictions({ action: request.action }),
        view.getClaim(invocationId),
      ]);
    const now = this.#clock();

    if (existingClaim !== null) {
      const claimedGrant = await view.getGrant(existingClaim.grantId);
      const replayGrants =
        claimedGrant === null
          ? []
          : await loadGrantsWithAncestors(view, [claimedGrant]);
      return await this.#handleExistingClaim(
        existingClaim,
        request,
        replayGrants,
        restrictions,
        now,
        options
      );
    }

    const grants = await loadGrantsWithAncestors(view, activeGrants);
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
        request,
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
      invocationGrants,
      request,
      invocationId,
      now,
      options
    );
  }

  async #handleExistingClaim(
    claim: InvocationClaim,
    request: AccessRequest,
    grants: readonly Grant[],
    restrictions: readonly Restriction[],
    now: number,
    options: AuthorizeOptions
  ): Promise<AuthorizationTransactionResult> {
    if (options.idempotent !== true) {
      return {
        events: [],
        kind: "denied",
        reason: `Invocation ${claim.invocationId} has already been claimed`,
      };
    }
    if (!(await matchesRequestFingerprint(claim.requestFingerprint, request))) {
      return {
        events: [],
        kind: "denied",
        reason: `Invocation ${claim.invocationId} was claimed for a different request`,
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
    const validated = validateGrantForReplay(
      grant,
      request,
      grants,
      restrictions,
      now,
      claim.invocationId
    );
    if (validated.blockedByDeny !== undefined) {
      return {
        events: [],
        kind: "denied",
        reason: validated.blockedByDeny.reason,
        restrictionId: validated.blockedByDeny.id,
      };
    }
    if (validated.grantPath === undefined) {
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
        grantPath: validated.grantPath,
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
    request: AccessRequest,
    invocationId: string,
    now: number
  ): Promise<AuthorizationTransactionResult> {
    const requestFingerprint = await fingerprintRequest(request);
    const claim: InvocationClaim = {
      claimedAt: now,
      grantId: selected.id,
      invocationId,
      ...(requestFingerprint === null ? {} : { requestFingerprint }),
    };
    const grantMap = new Map(grants.map((item) => [item.id, item]));
    const updatedGrants: Grant[] = [];
    const expectedGrantRevisions: Record<GrantId, number> = {};
    const events: AuthorizationEvent[] = [];

    for (const id of uniqueIds(grantPath)) {
      const member = grantMap.get(id);
      if (member === undefined) {
        continue;
      }
      expectedGrantRevisions[member.id] = member.revision;
      if (member.usesRemaining === undefined) {
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
      createClaims: [claim],
      expectedGrantRevisions,
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
    const scope = scopeFromRequest(request);
    const existingPending = grants.find(
      (item) => item.invocationId === invocationId && item.state === "pending"
    );
    if (existingPending !== undefined) {
      if (isExpired(existingPending, now)) {
        return {
          events: [],
          kind: "denied",
          reason: "Pending grant request has expired",
        };
      }
      if (
        scope === null ||
        !matchesPendingGrantForRequest(existingPending, request, scope)
      ) {
        return {
          events: [],
          kind: "denied",
          reason: `Invocation ${invocationId} is already bound to a different pending grant`,
        };
      }
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
      id: this.#nextGrantId(),
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
          dispatchEvent(this.#hub, event);
        }
      });
      return;
    }
    for (const event of events) {
      dispatchEvent(this.#hub, event);
    }
  }

  #nextGrantId(): GrantId {
    return asGrantId(this.#generateId("grt"));
  }

  #nextRestrictionId(): RestrictionId {
    return asRestrictionId(this.#generateId("rst"));
  }
}
