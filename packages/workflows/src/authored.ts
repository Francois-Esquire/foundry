import { z } from "zod";

import type {
  DefinitionGraphBuilder,
  RunExecutionContext,
} from "./definitions";
import type { BaseContext } from "./executable";
import type { JsonValue } from "./json-value";
import type { StepContext } from "./step";

import { Step } from "./step";
import { Workflow } from "./workflow";

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

export interface StepEntry {
  readonly availability:
    | { readonly status: "available" }
    | { readonly status: "unavailable"; readonly reason: string };
  readonly contract: StepContract;
}

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

function composeMessage(fields: {
  step?: string;
  placement?: string;
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
  return type === "text" ? true : value.length > 0;
}

export function validateLinear(
  plan: LinearPlan,
  entries: ReadonlyMap<string, StepEntry>
): Validity {
  const issues: Issue[] = [];

  if (plan.placements.length === 0) {
    issues.push(
      makeIssue({
        boundary: "composition",
        code: "empty",
        reason: REASON.empty,
      })
    );
  }

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

  const context: ValidationContext = {
    entries,
    firstIndexByKey,
    placements: plan.placements,
    runInputByKey,
  };
  plan.placements.forEach((placement, index) => {
    validatePlacement(placement, index, context, issues);
  });

  return issues.length === 0
    ? { executable: true, issues: [] }
    : { executable: false, issues };
}

type FlagIssue = (fields: {
  boundary: IssueBoundary;
  key?: string;
  code: Issue["code"];
  reason: string;
}) => void;

interface ValidationContext {
  entries: ReadonlyMap<string, StepEntry>;
  firstIndexByKey: ReadonlyMap<string, number>;
  placements: readonly Placement[];
  runInputByKey: ReadonlyMap<string, RunInput>;
}

function validatePlacement(
  placement: Placement,
  index: number,
  context: ValidationContext,
  issues: Issue[]
): void {
  const flag = placementFlag(placement, issues);
  const contract = admittedContract(placement.step, context.entries, flag);
  const contractInput = new Map(
    (contract?.inputs ?? []).map((input) => [input.key, input])
  );

  for (const [inputKey, assignment] of Object.entries(placement.inputs)) {
    validateAssignment(
      assignment,
      inputKey,
      index,
      contract,
      contractInput.get(inputKey),
      context,
      flag
    );
  }
  if (contract) {
    validateMissingRequired(placement, contract, flag);
  }
}

function placementFlag(placement: Placement, issues: Issue[]): FlagIssue {
  return (fields) => {
    issues.push(
      makeIssue({ placement: placement.key, step: placement.step, ...fields })
    );
  };
}

function admittedContract(
  step: string,
  entries: ReadonlyMap<string, StepEntry>,
  flag: FlagIssue
): StepContract | undefined {
  const entry = entries.get(step);
  if (entry === undefined) {
    flag({
      boundary: "placement",
      code: "step-not-admitted",
      reason: REASON.stepNotAdmitted,
    });
    return undefined;
  }
  if (entry.availability.status === "unavailable") {
    flag({
      boundary: "placement",
      code: "step-unavailable",
      reason: entry.availability.reason,
    });
    return undefined;
  }
  return entry.contract;
}

function validateAssignment(
  assignment: Assignment,
  inputKey: string,
  index: number,
  contract: StepContract | undefined,
  inputContract: InputContract | undefined,
  context: ValidationContext,
  flag: FlagIssue
): void {
  if (assignment.source === "run") {
    validateRunAssignment(
      assignment,
      inputKey,
      contract,
      inputContract,
      context.runInputByKey,
      flag
    );
    return;
  }
  if (assignment.source === "connection") {
    validateConnectionAssignment(
      assignment,
      inputKey,
      index,
      contract,
      inputContract,
      context,
      flag
    );
    return;
  }
  validateSettingAssignment(
    assignment,
    inputKey,
    contract,
    inputContract,
    flag
  );
}

function validateRunAssignment(
  assignment: Extract<Assignment, { source: "run" }>,
  inputKey: string,
  contract: StepContract | undefined,
  inputContract: InputContract | undefined,
  runInputs: ReadonlyMap<string, RunInput>,
  flag: FlagIssue
): void {
  const runInput = runInputs.get(assignment.input);
  if (runInput === undefined) {
    flag({
      boundary: "run-input",
      code: "unknown-run-input",
      key: inputKey,
      reason: REASON.unknownRunInput,
    });
  }
  if (!contract) {
    return;
  }
  if (inputContract === undefined) {
    flag({
      boundary: "input",
      code: "unknown-input",
      key: inputKey,
      reason: REASON.unknownInput,
    });
    return;
  }
  if (runInput === undefined) {
    return;
  }
  if (runInput.type !== inputContract.type) {
    flag({
      boundary: "run-input",
      code: "type-mismatch",
      key: inputKey,
      reason: REASON.runTypeMismatch,
    });
  } else if (inputContract.required && !runInput.required) {
    flag({
      boundary: "run-input",
      code: "missing-required",
      key: inputKey,
      reason: `requires an assignment, but Run-start Input ${runInput.key} is optional`,
    });
  }
}

function validateConnectionAssignment(
  assignment: Extract<Assignment, { source: "connection" }>,
  inputKey: string,
  index: number,
  contract: StepContract | undefined,
  inputContract: InputContract | undefined,
  context: ValidationContext,
  flag: FlagIssue
): void {
  const sourceIndex = context.firstIndexByKey.get(assignment.placement);
  const resolvesEarlier = sourceIndex !== undefined && sourceIndex < index;
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
  const sourcePlacement = resolvesEarlier
    ? context.placements[sourceIndex]
    : undefined;
  const sourceEntry = sourcePlacement
    ? context.entries.get(sourcePlacement.step)
    : undefined;
  const sourceContract =
    sourceEntry?.availability.status === "available"
      ? sourceEntry.contract
      : undefined;
  if (sourceContract?.result === null) {
    flag({
      boundary: "connection",
      code: "no-result",
      key: inputKey,
      reason: REASON.noResult,
    });
  }
  if (
    contract &&
    inputContract !== undefined &&
    sourceContract?.result !== null &&
    sourceContract?.result !== undefined &&
    sourceContract.result.type !== inputContract.type
  ) {
    flag({
      boundary: "connection",
      code: "type-mismatch",
      key: inputKey,
      reason: REASON.connectionTypeMismatch,
    });
  }
  if (contract && inputContract === undefined) {
    flag({
      boundary: "input",
      code: "unknown-input",
      key: inputKey,
      reason: REASON.unknownInput,
    });
  }
}

function validateSettingAssignment(
  assignment: Extract<Assignment, { source: "setting" }>,
  inputKey: string,
  contract: StepContract | undefined,
  inputContract: InputContract | undefined,
  flag: FlagIssue
): void {
  if (!contract) {
    return;
  }
  if (inputContract === undefined) {
    flag({
      boundary: "input",
      code: "unknown-input",
      key: inputKey,
      reason: REASON.unknownInput,
    });
  } else if (!settingSatisfies(inputContract.type, assignment.value)) {
    flag({
      boundary: "input",
      code: "type-mismatch",
      key: inputKey,
      reason: REASON.settingTypeMismatch,
    });
  }
}

function validateMissingRequired(
  placement: Placement,
  contract: StepContract,
  flag: FlagIssue
): void {
  for (const input of contract.inputs) {
    if (input.required && placement.inputs[input.key] === undefined) {
      flag({
        boundary: "input",
        code: "missing-required",
        key: input.key,
        reason: REASON.missingRequired,
      });
    }
  }
}

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

export type EvidenceRecord =
  | BoundContractRecord
  | ContractFailureRecord
  | RehydrationRecord
  | InterruptedRecord;

export interface InvocationContext {
  claimEffect(key: string, metadata?: JsonValue): Promise<boolean>;
  emit(output: Output): Promise<void>;
  live(value: JsonValue): void;
  readonly placement: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}

export interface RehydrateContext {
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

export interface AuthoredRunInput {
  readonly inputs: Readonly<Record<string, string>>;
  readonly snapshotId: string;
  readonly versionId?: string;
}

export interface RunEvidence {
  readonly bound: BoundContractRecord | null;
  readonly outputs: readonly StampedOutput[];
}

export interface EvidenceHost {
  evidenceOf(runId: string, placement: string): Promise<RunEvidence>;
  recordEvidence(runId: string, record: EvidenceRecord): Promise<void>;
}

export class ContractFailure extends Error {
  override readonly name = "ContractFailure";
}

export class StepUnavailable extends Error {
  override readonly name = "StepUnavailable";
}

export class InvocationInterrupted extends Error {
  override readonly name = "InvocationInterrupted";
  readonly claim: string;
  constructor(claim: string, message?: string) {
    super(message ?? `invocation interrupted: claim ${claim} already taken`);
    this.claim = claim;
  }
}

export interface AuthoredContext extends BaseContext {
  readonly execution: RunExecutionContext;
}

type Resolve = (key: string) => TrustedStep | null | undefined;

function stamp(output: Output, placement: string, step: string): StampedOutput {
  const {
    placement: _p,
    step: _s,
    ...rest
  } = output as Output & Partial<StampedOutput>;
  return { ...rest, placement, step };
}

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
  readonly #results = new Map<string, string | null>();
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
      const next = builder.step(placement.key, leaf, (values) => {
        if (previous !== undefined) {
          Reflect.get(values, previous);
        }
        return values.input;
      });
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
    const { runId } = exec;
    const placement = this.#placementByKey.get(placementKey);
    if (placement === undefined) {
      throw new StepUnavailable(`no placement ${placementKey} in plan`);
    }

    const step = this.#resolveStep(placement.step, placementKey);

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
      return null;
    }
    if (assignment.source === "setting") {
      return assignment.value;
    }
    if (assignment.source === "run") {
      return runInput.inputs[assignment.input] ?? null;
    }
    const source = assignment.placement;
    const inMemory = this.#results.get(source);
    if (inMemory !== null && inMemory !== undefined) {
      return inMemory;
    }
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
    if (evidence.bound === null || sourcePlacement === undefined) {
      this.#rehydrated.set(source, null);
      return null;
    }

    const boundContract = evidence.bound.contract;
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
      return;
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

export function materializeLinear(
  plan: LinearPlan,
  resolve: Resolve,
  host: EvidenceHost
): Workflow<AuthoredRunInput, null, AuthoredContext> {
  return new MaterializedWorkflow(plan, resolve, host);
}
