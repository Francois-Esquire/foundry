/**
 * `@foundry/workflows/authored` — the authored-plan surface four callers (editor,
 * service, Library, launch router) and every Step author agree on.
 *
 * Two halves live here. The pure half — the contract vocabulary and
 * `validateLinear` — holds no state and performs no I/O: it evaluates every Spec 01
 * rule against a structurally valid plan and the catalog's current entries, returns
 * all issues (never first-failure), and addresses each to the smallest authored
 * element. The runtime half — `TrustedStep` with its `InvocationContext`/
 * `RehydrateContext`, and `materializeLinear` with the Invocation it builds — holds
 * per-Run state (the in-memory Result and rehydration caches) and reads and writes
 * durable evidence through the injected host, never persisting a Result.
 */

import { z } from "zod";

import type { DefinitionGraphBuilder } from "./definitions";
import type { BaseContext } from "./executable";
import type { JsonValue } from "./execution-records";
import type { RunExecutionContext } from "./orchestrator";
import type { StepContext } from "./step";

import { Step } from "./step";
import { Workflow } from "./workflow";

// ─── Contract vocabulary ─────────────────────────────────────────────────────

export type ValueType = "text" | "artifact" | "workspace" | "harness";

export interface InputContract {
  readonly control?: "text" | "textarea" | "select";
  readonly description?: string;
  readonly key: string;
  readonly label: string;
  readonly optionSource?: "harnesses" | "workspaces" | "artifacts";
  readonly required: boolean;
  readonly type: ValueType;
}

export type OutputKind = "account" | "artifact" | "session" | "value";

export interface StepContract {
  readonly inputs: readonly InputContract[];
  readonly outputs: readonly OutputKind[];
  readonly rehydrate?: "session" | "artifact";
  readonly result: { readonly type: ValueType; readonly label?: string } | null;
}

export type ResolvedInputs = Readonly<Record<string, string | null>>;

// ─── Linear plan ─────────────────────────────────────────────────────────────

export interface RunInput {
  readonly description?: string;
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly type: ValueType;
}

export type Assignment =
  | { readonly source: "setting"; readonly value: string }
  | { readonly source: "run"; readonly input: string }
  | { readonly source: "connection"; readonly placement: string };

export interface Placement {
  readonly inputs: Readonly<Record<string, Assignment>>;
  readonly key: string;
  readonly step: string;
}

export interface LinearPlan {
  readonly inputs: readonly RunInput[];
  readonly placements: readonly Placement[];
  readonly schema: 1;
}

// ─── Validity ────────────────────────────────────────────────────────────────

export type IssueBoundary =
  | "placement"
  | "input"
  | "connection"
  | "run-input"
  | "composition";

export interface Issue {
  readonly boundary: IssueBoundary;
  readonly code:
    | "step-not-admitted"
    | "step-unavailable"
    | "missing-required"
    | "type-mismatch"
    | "unknown-input"
    | "forward-connection"
    | "unknown-placement"
    | "unknown-run-input"
    | "no-result"
    | "duplicate-key"
    | "empty";
  readonly key?: string;
  readonly message: string;
  readonly placement?: string;
  readonly step?: string;
}

export type Validity =
  | { readonly executable: true; readonly issues: readonly [] }
  | { readonly executable: false; readonly issues: readonly Issue[] };

/**
 * What `validateLinear` needs about one catalog Step: its Contract and its
 * availability. Structurally identical to `StepDescriptor`'s `contract` and
 * `availability` (structures.md), passed as the value of the `entries` map so
 * the validator never reaches for a Step, a catalog, or a runtime.
 */
export interface StepEntry {
  readonly availability:
    | { readonly status: "available" }
    | { readonly status: "unavailable"; readonly reason: string };
  readonly contract: StepContract;
}

// ─── LinearPlanSchema ────────────────────────────────────────────────────────

const ValueTypeSchema = z.enum(["text", "artifact", "workspace", "harness"]);

const AssignmentSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("setting"), value: z.string() }),
  z.object({ input: z.string().min(1), source: z.literal("run") }),
  z.object({ placement: z.string().min(1), source: z.literal("connection") }),
]);

const RunInputSchema = z.object({
  description: z.string().optional(),
  key: z.string().min(1),
  label: z.string(),
  required: z.boolean(),
  type: ValueTypeSchema,
});

const PlacementSchema = z.object({
  inputs: z.record(z.string(), AssignmentSchema),
  key: z.string().min(1),
  step: z.string().min(1),
});

function hasUniqueKeys(keys: readonly string[]): boolean {
  return new Set(keys).size === keys.length;
}

/**
 * Structural gate every caller parses with. It refuses a wrong `schema`, empty
 * keys, duplicate placement or run-input keys, malformed assignments, and a
 * non-string `setting.value`. It does NOT require a placement: the empty-plan
 * case is a `validateLinear` rule (`composition/empty`), not a structural one.
 */
export const LinearPlanSchema: z.ZodType<LinearPlan> = z
  .object({
    inputs: z.array(RunInputSchema),
    placements: z.array(PlacementSchema),
    schema: z.literal(1),
  })
  .refine((plan) => hasUniqueKeys(plan.placements.map((p) => p.key)), {
    message: "placement keys must be unique",
  })
  .refine((plan) => hasUniqueKeys(plan.inputs.map((i) => i.key)), {
    message: "run-input keys must be unique",
  });

// ─── validateLinear ──────────────────────────────────────────────────────────

const REASON = {
  connectionTypeMismatch: "type-mismatch",
  duplicateKey: "duplicate-key",
  empty: "a plan must place at least one Step",
  forwardConnection: "must connect to an earlier placement",
  missingRequired: "missing-required",
  noResult: "no-result",
  runTypeMismatch: "type-mismatch",
  settingTypeMismatch: "type-mismatch",
  stepNotAdmitted: "step-not-admitted",
  unknownInput: "is not an input of this Step",
  unknownPlacement: "is not a placement in this plan",
  unknownRunInput: "is not a declared Run-start Input",
} as const;

/**
 * Compose the one line four surfaces render:
 * `"<step> at <placement>: <boundary> <key> <reason>"`. The `<step> at
 * <placement>: ` head is present only when both are known; the `<key> ` slot is
 * present only when the issue addresses a key. This renders the three issue
 * shapes — full, placement-boundary (no key), and address-less (no head) — from
 * one composer, so changing `" at "` reddens every exact-string assertion.
 */
function composeMessage(fields: {
  step?: string;
  placement?: string;
  // `IssueBoundary` at validate time; also the runtime `"result"` boundary the
  // Invocation attributes. The composer only interpolates it, so one line
  // implementation serves both — changing `" at "` reddens every assertion.
  boundary: IssueBoundary | "result";
  key?: string;
  reason: string;
}): string {
  const head =
    fields.step !== undefined && fields.placement !== undefined
      ? `${fields.step} at ${fields.placement}: `
      : "";
  const keyPart = fields.key === undefined ? "" : `${fields.key} `;
  return `${head}${fields.boundary} ${keyPart}${fields.reason}`;
}

function makeIssue(fields: {
  placement?: string;
  step?: string;
  boundary: IssueBoundary;
  key?: string;
  code: Issue["code"];
  reason: string;
}): Issue {
  const { placement, step, boundary, key, code, reason } = fields;
  return {
    ...(placement === undefined ? {} : { placement }),
    ...(step === undefined ? {} : { step }),
    boundary,
    ...(key === undefined ? {} : { key }),
    code,
    message: composeMessage({ boundary, key, placement, reason, step }),
  };
}

function duplicates(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      dupes.add(key);
    } else {
      seen.add(key);
    }
  }
  return [...dupes];
}

function settingSatisfies(type: ValueType, value: string): boolean {
  // `text` is any string (including ""); the id-bearing types must be non-empty.
  return type === "text" ? true : value.length > 0;
}

/**
 * The single executability decision. Pure and deterministic: equal inputs give
 * an equal `Validity`. Evaluates every Spec 01 rule, reports all issues, and
 * addresses each to the smallest authored element. Contract-dependent rules of a
 * placement whose Step is unadmitted or unavailable are skipped; that
 * placement's plan-only Input and Connection issues are still reported.
 */
export function validateLinear(
  plan: LinearPlan,
  entries: ReadonlyMap<string, StepEntry>
): Validity {
  const issues: Issue[] = [];

  // composition/empty — plan-only, address-less.
  if (plan.placements.length === 0) {
    issues.push(
      makeIssue({
        boundary: "composition",
        code: "empty",
        reason: REASON.empty,
      })
    );
  }

  // duplicate-key — plan-only defense (the schema also refuses). First
  // occurrence of a placement key wins for connection resolution below.
  for (const key of duplicates(plan.placements.map((p) => p.key))) {
    issues.push(
      makeIssue({
        boundary: "placement",
        code: "duplicate-key",
        key,
        reason: REASON.duplicateKey,
      })
    );
  }
  for (const key of duplicates(plan.inputs.map((i) => i.key))) {
    issues.push(
      makeIssue({
        boundary: "run-input",
        code: "duplicate-key",
        key,
        reason: REASON.duplicateKey,
      })
    );
  }

  const runInputByKey = new Map(plan.inputs.map((i) => [i.key, i]));
  const firstIndexByKey = new Map<string, number>();
  plan.placements.forEach((p, index) => {
    if (!firstIndexByKey.has(p.key)) {
      firstIndexByKey.set(p.key, index);
    }
  });

  plan.placements.forEach((placement, index) => {
    const { key: placementKey, step } = placement;
    const entry = entries.get(step);
    const flag = (f: {
      boundary: IssueBoundary;
      key?: string;
      code: Issue["code"];
      reason: string;
    }): void => {
      issues.push(makeIssue({ placement: placementKey, step, ...f }));
    };

    // Admission and availability — plan-relative, but the address carries the
    // Step name. When absent or unavailable, contract-dependent rules skip.
    let contract: StepContract | undefined;
    if (entry === undefined) {
      flag({
        boundary: "placement",
        code: "step-not-admitted",
        reason: REASON.stepNotAdmitted,
      });
    } else if (entry.availability.status === "unavailable") {
      flag({
        boundary: "placement",
        code: "step-unavailable",
        reason: entry.availability.reason,
      });
    } else {
      contract = entry.contract;
    }

    const contractInput = new Map(
      (contract?.inputs ?? []).map((i) => [i.key, i])
    );

    for (const [inputKey, assignment] of Object.entries(placement.inputs)) {
      const ic = contract ? contractInput.get(inputKey) : undefined;

      if (assignment.source === "run") {
        const runInput = runInputByKey.get(assignment.input);
        // Plan-only: the named Run-start Input must exist.
        if (runInput === undefined) {
          flag({
            boundary: "run-input",
            code: "unknown-run-input",
            key: inputKey,
            reason: REASON.unknownRunInput,
          });
        }
        if (contract) {
          if (ic === undefined) {
            flag({
              boundary: "input",
              code: "unknown-input",
              key: inputKey,
              reason: REASON.unknownInput,
            });
          } else if (runInput !== undefined) {
            if (runInput.type !== ic.type) {
              flag({
                boundary: "run-input",
                code: "type-mismatch",
                key: inputKey,
                reason: REASON.runTypeMismatch,
              });
            } else if (ic.required && !runInput.required) {
              flag({
                boundary: "run-input",
                code: "missing-required",
                key: inputKey,
                reason: `requires an assignment, but Run-start Input ${runInput.key} is optional`,
              });
            }
          }
        }
        continue;
      }

      if (assignment.source === "connection") {
        const sourceIndex = firstIndexByKey.get(assignment.placement);
        const resolvesEarlier =
          sourceIndex !== undefined && sourceIndex < index;
        // Plan-only: the source must exist and be strictly earlier.
        if (sourceIndex === undefined) {
          flag({
            boundary: "connection",
            code: "unknown-placement",
            key: inputKey,
            reason: REASON.unknownPlacement,
          });
        } else if (!resolvesEarlier) {
          flag({
            boundary: "connection",
            code: "forward-connection",
            key: inputKey,
            reason: REASON.forwardConnection,
          });
        }

        // Source- and both-contract rules only apply to a resolved earlier
        // producer that is itself admitted and available.
        const sourcePlacement = resolvesEarlier
          ? plan.placements[sourceIndex]
          : undefined;
        const sourceEntry = sourcePlacement
          ? entries.get(sourcePlacement.step)
          : undefined;
        const sourceContract =
          sourceEntry?.availability.status === "available"
            ? sourceEntry.contract
            : undefined;

        if (sourceContract) {
          if (sourceContract.result === null) {
            flag({
              boundary: "connection",
              code: "no-result",
              key: inputKey,
              reason: REASON.noResult,
            });
          }
          if (
            contract &&
            ic !== undefined &&
            sourceContract.result !== null &&
            sourceContract.result.type !== ic.type
          ) {
            flag({
              boundary: "connection",
              code: "type-mismatch",
              key: inputKey,
              reason: REASON.connectionTypeMismatch,
            });
          }
        }

        if (contract && ic === undefined) {
          flag({
            boundary: "input",
            code: "unknown-input",
            key: inputKey,
            reason: REASON.unknownInput,
          });
        }
        continue;
      }

      // source === "setting"
      if (contract) {
        if (ic === undefined) {
          flag({
            boundary: "input",
            code: "unknown-input",
            key: inputKey,
            reason: REASON.unknownInput,
          });
        } else if (!settingSatisfies(ic.type, assignment.value)) {
          flag({
            boundary: "input",
            code: "type-mismatch",
            key: inputKey,
            reason: REASON.settingTypeMismatch,
          });
        }
      }
    }

    // missing-required sweep — contract-dependent, after per-assignment rules.
    if (contract) {
      for (const ic of contract.inputs) {
        if (ic.required && placement.inputs[ic.key] === undefined) {
          flag({
            boundary: "input",
            code: "missing-required",
            key: ic.key,
            reason: REASON.missingRequired,
          });
        }
      }
    }
  });

  return issues.length === 0
    ? { executable: true, issues: [] }
    : { executable: false, issues };
}

// ═════════════════════════════════════════════════════════════════════════════
// Runtime half (Step 02): the Invocation, its evidence, and the materializer
// ═════════════════════════════════════════════════════════════════════════════

// ─── Outputs and evidence frames ─────────────────────────────────────────────

export type Output =
  | { readonly kind: "account"; readonly text: string }
  | {
      readonly kind: "artifact";
      readonly artifactId: string;
      readonly contentId?: string;
      readonly generationRunId?: string;
      readonly note?: string;
    }
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly note?: string;
    }
  | {
      readonly kind: "value";
      readonly label: string;
      readonly value: JsonValue;
    };

export type StampedOutput = Output & {
  readonly placement: string;
  readonly step: string;
};

export interface BoundContractRecord {
  readonly contract: StepContract;
  readonly event: "invocation-bound";
  readonly placement: string;
  readonly step: string;
}

export interface ContractFailureRecord {
  readonly boundary: "input" | "connection" | "result";
  readonly event: "contract-failure";
  readonly from?: string;
  readonly key: string;
  readonly placement: string;
  readonly reason: string;
  readonly step: string;
}

export interface RehydrationRecord {
  readonly event: "result-rehydrated";
  readonly from: "session" | "artifact";
  readonly placement: string;
  readonly reason?: "nothing-retained" | "rehydrate-not-implemented";
  readonly restored: boolean;
  readonly step: string;
}

export interface InterruptedRecord {
  readonly claim: string;
  readonly event: "invocation-interrupted";
  readonly placement: string;
  readonly step: string;
}

/** Every durable evidence record the materializer appends as a `log` frame. */
export type EvidenceRecord =
  | BoundContractRecord
  | ContractFailureRecord
  | RehydrationRecord
  | InterruptedRecord;

// ─── Invocation and rehydrate context ────────────────────────────────────────

export interface InvocationContext {
  claimEffect(key: string, metadata?: JsonValue): Promise<boolean>;
  emit(output: Output): Promise<void>;
  live(value: JsonValue): void;
  readonly placement: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}

export interface RehydrateContext {
  /** The Contract the producing Invocation bound at start, from its BoundContractRecord. */
  readonly contract: StepContract;
  readonly inputs: ResolvedInputs;
  readonly outputs: readonly StampedOutput[];
  readonly placement: string;
  readonly runId: string;
}

export interface TrustedStep<R = string> {
  readonly contract: StepContract;
  readonly description?: string;
  invoke(inputs: ResolvedInputs, context: InvocationContext): Promise<R | null>;
  readonly key: string;
  readonly name: string;
  rehydrate?(context: RehydrateContext): Promise<R | null>;
}

// ─── AuthoredRunInput and the evidence host ──────────────────────────────────

export interface AuthoredRunInput {
  readonly inputs: Readonly<Record<string, string>>;
  readonly snapshotId: string;
  readonly versionId?: string;
}

/** One placement's evidence read back from the journal by the host. */
export interface RunEvidence {
  readonly bound: BoundContractRecord | null;
  readonly outputs: readonly StampedOutput[];
}

/**
 * The seam the materializer reads and writes evidence through. Architecture
 * freezes `RunExecutionContext` to `claimEffect`/`emitOutput`, so the journal
 * read (`evidenceOf`) and the evidence-record write (`recordEvidence`) are
 * owned by the factory's host and injected here — no public runtime contract
 * changes. Step 04 supplies the real host; specs supply a journal-backed one.
 */
export interface EvidenceHost {
  evidenceOf(runId: string, placement: string): Promise<RunEvidence>;
  recordEvidence(runId: string, record: EvidenceRecord): Promise<void>;
}

// ─── Seam errors (plain Errors with exact `name`s, read by `step.failed`) ─────

/** Input/Result boundary rejection; `step.failed` reads `name`. */
export class ContractFailure extends Error {
  override readonly name = "ContractFailure";
}

/** `resolve(placement.step)` threw or returned nothing at Invocation start. */
export class StepUnavailable extends Error {
  override readonly name = "StepUnavailable";
}

/** A Step's effect claim returned `false` on adoption with no completion. */
export class InvocationInterrupted extends Error {
  override readonly name = "InvocationInterrupted";
  readonly claim: string;
  constructor(claim: string, message?: string) {
    super(message ?? `invocation interrupted: claim ${claim} already taken`);
    this.claim = claim;
  }
}

// ─── materializeLinear ───────────────────────────────────────────────────────

/** Execution context the leaves receive: the Run's durable effect surface. */
export interface AuthoredContext extends BaseContext {
  readonly execution: RunExecutionContext;
}

/** The resolver may return nothing for an unadmitted/unavailable Step. */
type Resolve = (key: string) => TrustedStep | null | undefined;

/** Add the materializer's `placement`/`step`, ignoring any a Step supplied. */
function stamp(output: Output, placement: string, step: string): StampedOutput {
  const {
    placement: _p,
    step: _s,
    ...rest
  } = output as Output & Partial<StampedOutput>;
  return { ...rest, placement, step };
}

/**
 * One leaf per placement. Holds only a placement key and the owner's per-Run
 * invocation body; its `definitionKey` makes it a valid graph child. Sequencing
 * and failure propagation come from the builder chain in
 * {@link MaterializedWorkflow.define}, not from this leaf.
 */
class AuthoredLeaf extends Step<
  AuthoredRunInput,
  string | null,
  AuthoredContext
> {
  readonly definitionKey: string;
  readonly #invoke: (
    input: AuthoredRunInput,
    ctx: StepContext<AuthoredRunInput, string | null, AuthoredContext>
  ) => Promise<string | null>;

  constructor(
    definitionKey: string,
    invoke: (
      input: AuthoredRunInput,
      ctx: StepContext<AuthoredRunInput, string | null, AuthoredContext>
    ) => Promise<string | null>
  ) {
    super();
    this.definitionKey = definitionKey;
    this.#invoke = invoke;
  }

  protected execute(
    input: AuthoredRunInput,
    ctx: StepContext<AuthoredRunInput, string | null, AuthoredContext>
  ): Promise<string | null> {
    return this.#invoke(input, ctx);
  }
}

/**
 * A plan materialized into an ordinary runtime `Workflow` with
 * `persistence.results = "transient"`. One instance per Run (the factory calls
 * {@link materializeLinear} on run and on every recovery), so the in-memory
 * Result and rehydration caches are per-Run state held on the instance. Each
 * placement is an Invocation: bind the current Step's Contract, resolve and
 * verify inputs against that bound Contract, invoke, verify the Result, and
 * keep the Result in memory only — writing nothing but deliberate Outputs and
 * attributed evidence.
 */
class MaterializedWorkflow extends Workflow<
  AuthoredRunInput,
  null,
  AuthoredContext
> {
  readonly definitionKey = "workflow.authored";
  override readonly persistence = { results: "transient" } as const;

  readonly #plan: LinearPlan;
  readonly #resolve: Resolve;
  readonly #host: EvidenceHost;
  readonly #placementByKey: ReadonlyMap<string, Placement>;
  /** Results produced in this process, keyed by placement (`null` allowed). */
  readonly #results = new Map<string, string | null>();
  /** One rehydration attempt per source per Run; caches the restored value. */
  readonly #rehydrated = new Map<string, string | null>();

  constructor(plan: LinearPlan, resolve: Resolve, host: EvidenceHost) {
    super();
    this.#plan = plan;
    this.#resolve = resolve;
    this.#host = host;
    this.#placementByKey = new Map(plan.placements.map((p) => [p.key, p]));
  }

  protected define(
    graph: DefinitionGraphBuilder<
      AuthoredRunInput,
      null,
      Record<string, unknown>,
      AuthoredContext
    >
  ): void {
    let builder = graph;
    this.#plan.placements.forEach((placement, index) => {
      const previous =
        index > 0 ? this.#plan.placements[index - 1]?.key : undefined;
      const leaf = new AuthoredLeaf(
        `workflow.authored.leaf:${placement.key}`,
        (input, ctx) => this.#invokePlacement(placement.key, input, ctx)
      );
      // Referencing the previous placement's value forces strict linear order
      // and failure propagation (a failed Invocation fails the Run); the value
      // itself is ignored — Connections flow through `#results`, not the graph.
      const next = builder.step(placement.key, leaf, (values) => {
        if (previous !== undefined) {
          void values[previous];
        }
        return values.input;
      });
      // The builder's `Values` grows per `.step`; the loop keeps the widened
      // record view so the dynamic chain type-checks.
      builder = next;
    });
    builder.output(() => null);
  }

  async #invokePlacement(
    placementKey: string,
    runInput: AuthoredRunInput,
    ctx: StepContext<AuthoredRunInput, string | null, AuthoredContext>
  ): Promise<string | null> {
    const exec = ctx.execution;
    const runId = exec.runId;
    const placement = this.#placementByKey.get(placementKey);
    if (placement === undefined) {
      throw new StepUnavailable(`no placement ${placementKey} in plan`);
    }

    const step = this.#resolveStep(placement.step, placementKey);

    // Bound Contract recorded before any other work of this Invocation.
    await this.#host.recordEvidence(runId, {
      contract: step.contract,
      event: "invocation-bound",
      placement: placementKey,
      step: placement.step,
    });

    const resolved: Record<string, string | null> = {};
    for (const ic of step.contract.inputs) {
      resolved[ic.key] = await this.#resolveInput(
        placement,
        ic,
        runInput,
        runId
      );
    }

    await this.#verifyInputs(runId, placement, step.contract, resolved);

    const invocationContext: InvocationContext = {
      claimEffect: (key, metadata) => exec.claimEffect(key, metadata),
      emit: async (output) => {
        await exec.emitOutput(stamp(output, placementKey, placement.step));
      },
      live: (value) => {
        ctx.emit("authored:live", value);
      },
      placement: placementKey,
      runId,
      signal: ctx.signal,
    };

    let result: string | null;
    try {
      result = await step.invoke(resolved, invocationContext);
    } catch (cause) {
      if (cause instanceof InvocationInterrupted) {
        await this.#host.recordEvidence(runId, {
          claim: cause.claim,
          event: "invocation-interrupted",
          placement: placementKey,
          step: placement.step,
        });
      }
      throw cause;
    }

    await this.#verifyResult(runId, placement, step.contract, result);

    this.#results.set(placementKey, result);
    return result;
  }

  #resolveStep(stepKey: string, placementKey: string): TrustedStep {
    let step: TrustedStep | null;
    try {
      step = this.#resolve(stepKey) ?? null;
    } catch {
      step = null;
    }
    if (step === null) {
      throw new StepUnavailable(
        composeMessage({
          boundary: "placement",
          placement: placementKey,
          reason: "could not be resolved",
          step: stepKey,
        })
      );
    }
    return step;
  }

  async #resolveInput(
    placement: Placement,
    ic: InputContract,
    runInput: AuthoredRunInput,
    runId: string
  ): Promise<string | null> {
    const assignment = placement.inputs[ic.key];
    if (assignment === undefined) {
      return null; // unassigned optional → null
    }
    if (assignment.source === "setting") {
      return assignment.value;
    }
    if (assignment.source === "run") {
      return runInput.inputs[assignment.input] ?? null;
    }
    // Connection: read the in-memory Result of the source placement.
    const source = assignment.placement;
    const inMemory = this.#results.get(source);
    if (inMemory != null) {
      return inMemory;
    }
    // Absent or `null` → the lazy rehydrate path under the bound Contract.
    return this.#rehydrate(source, runInput, runId);
  }

  async #rehydrate(
    source: string,
    runInput: AuthoredRunInput,
    runId: string
  ): Promise<string | null> {
    if (this.#rehydrated.has(source)) {
      return this.#rehydrated.get(source) ?? null;
    }

    const evidence = await this.#host.evidenceOf(runId, source);
    const sourcePlacement = this.#placementByKey.get(source);
    // Source never completed (no bound record) → nothing to restore; no record.
    if (evidence.bound === null || sourcePlacement === undefined) {
      this.#rehydrated.set(source, null);
      return null;
    }

    const boundContract = evidence.bound.contract;
    // The bound Contract is the authority for `rehydrate`, not the current
    // catalog Contract. Undeclared → no owner, no record, value stays null.
    if (boundContract.rehydrate === undefined) {
      this.#rehydrated.set(source, null);
      return null;
    }

    const currentStep = this.#tryResolve(sourcePlacement.step);
    if (currentStep?.rehydrate === undefined) {
      await this.#host.recordEvidence(runId, {
        event: "result-rehydrated",
        from: boundContract.rehydrate,
        placement: source,
        reason: "rehydrate-not-implemented",
        restored: false,
        step: sourcePlacement.step,
      });
      this.#rehydrated.set(source, null);
      return null;
    }

    const value = await currentStep.rehydrate({
      contract: boundContract,
      inputs: this.#resolveSourceInputs(sourcePlacement, runInput),
      outputs: evidence.outputs,
      placement: source,
      runId,
    });
    await this.#host.recordEvidence(runId, {
      event: "result-rehydrated",
      from: boundContract.rehydrate,
      placement: source,
      restored: value !== null,
      step: sourcePlacement.step,
      ...(value === null ? { reason: "nothing-retained" as const } : {}),
    });
    this.#rehydrated.set(source, value);
    return value;
  }

  /**
   * Re-resolve the source's inputs at rehydrate time (its resolved inputs are
   * gone after a restart): Settings from the plan and Run-start values from the
   * input; connection-typed inputs read the in-memory/cached map only, never
   * recursively rehydrating.
   */
  #resolveSourceInputs(
    sourcePlacement: Placement,
    runInput: AuthoredRunInput
  ): ResolvedInputs {
    const resolved: Record<string, string | null> = {};
    for (const [key, assignment] of Object.entries(sourcePlacement.inputs)) {
      if (assignment.source === "setting") {
        resolved[key] = assignment.value;
      } else if (assignment.source === "run") {
        resolved[key] = runInput.inputs[assignment.input] ?? null;
      } else {
        resolved[key] =
          this.#results.get(assignment.placement) ??
          this.#rehydrated.get(assignment.placement) ??
          null;
      }
    }
    return resolved;
  }

  #tryResolve(stepKey: string): TrustedStep | undefined {
    try {
      return this.#resolve(stepKey) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async #verifyInputs(
    runId: string,
    placement: Placement,
    contract: StepContract,
    resolved: Readonly<Record<string, string | null>>
  ): Promise<void> {
    for (const ic of contract.inputs) {
      const value = resolved[ic.key] ?? null;
      const assignment = placement.inputs[ic.key];
      const isConnection = assignment?.source === "connection";
      const boundary = isConnection ? "connection" : "input";
      const from = isConnection ? assignment.placement : undefined;
      if (ic.required && value === null) {
        await this.#failContract(
          runId,
          placement,
          boundary,
          ic.key,
          "is null",
          from
        );
      }
      if (value !== null && !settingSatisfies(ic.type, value)) {
        await this.#failContract(
          runId,
          placement,
          boundary,
          ic.key,
          `is not a ${ic.type}`,
          from
        );
      }
    }
  }

  async #verifyResult(
    runId: string,
    placement: Placement,
    contract: StepContract,
    result: string | null
  ): Promise<void> {
    if (contract.result === null) {
      // A non-null return from a `result: null` Step is a result failure.
      if (result !== null) {
        await this.#failContract(
          runId,
          placement,
          "result",
          "result",
          "must be null"
        );
      }
      return;
    }
    if (result === null) {
      return; // a `null` Result is a legitimate absence.
    }
    if (
      typeof result !== "string" ||
      !settingSatisfies(contract.result.type, result)
    ) {
      await this.#failContract(
        runId,
        placement,
        "result",
        "result",
        `is not a ${contract.result.type}`
      );
    }
  }

  /** Append the attributed `ContractFailureRecord` and throw `ContractFailure`. */
  async #failContract(
    runId: string,
    placement: Placement,
    boundary: "input" | "connection" | "result",
    key: string,
    reason: string,
    from?: string
  ): Promise<never> {
    await this.#host.recordEvidence(runId, {
      boundary,
      event: "contract-failure",
      key,
      placement: placement.key,
      step: placement.step,
      ...(from === undefined ? {} : { from }),
      reason,
    });
    throw new ContractFailure(
      composeMessage({
        boundary,
        key,
        placement: placement.key,
        reason,
        step: placement.step,
      })
    );
  }
}

/**
 * Turn an executable-at-capture plan into an ordinary runtime `Workflow` whose
 * placements are Invocations. `resolve` binds each `placement.step` to its
 * current behavior; `host` reads prior evidence (`evidenceOf`) and writes new
 * evidence (`recordEvidence`) through the journal. The Workflow's output is
 * always `null` and its `persistence.results` is `transient`.
 */
export function materializeLinear(
  plan: LinearPlan,
  resolve: Resolve,
  host: EvidenceHost
): Workflow<AuthoredRunInput, null, AuthoredContext> {
  return new MaterializedWorkflow(plan, resolve, host);
}
