import type { ModuleStore } from "@foundry/modules/store/contract";
import { EXECUTION_STATUSES } from "@foundry.sh/marbles/statuses";
import { z } from "zod";
import { authorizeRuntime } from "~/main/gateway/authority";
import {
  constrained,
  defineStream,
  defineUnary,
  denied,
  described,
  fields,
  noConstraints,
  object,
  portable,
  required,
  text,
  type WorksCapability,
} from "~/main/gateway/provider-kit";
import type { ModuleWorkflows } from "./module-workflows";
import {
  WORKS_WORKFLOWS,
  type WorkflowRegistry,
  workflowIdentity,
} from "./workflows";

/** Works' execution operations for Module Programs (spec §7), all version 1. */
export const EXECUTION_CAPABILITIES = {
  cancel: "works.execution.cancel",
  start: "works.execution.start",
  watch: "works.execution.watch",
} as const;

/** What the providers act on. */
export interface ExecutionHost {
  readonly modules: Pick<ModuleStore, "loadGatewayContext">;
  readonly workflows: Pick<
    ModuleWorkflows,
    "cancel" | "cancelInstallation" | "start" | "watch"
  >;
}

const status = portable({
  description: "Where the execution is.",
  enum: [...EXECUTION_STATUSES],
  type: "string",
});
const executionField = text("The execution id `start` returned.");
const executionInput = fields({
  execution: required(z.string().min(1).max(200), executionField),
});

/** Watch and cancel act only on the caller's own executions: no constraints, one digest. */
const ownOnly = (capability: string) =>
  noConstraints(
    capability,
    "own",
    `${capability} acts on this app's own executions; it takes no constraints`
  );

const startConstraints = z
  .object({ workflows: z.array(z.string().min(1)).min(1).max(32) })
  .strict();

/**
 * The registered workflows (`id@version`) a Module may start, sorted and
 * deduplicated. An unregistered one refuses the whole request.
 */
function startPolicy(registry: WorkflowRegistry = WORKS_WORKFLOWS) {
  return constrained(EXECUTION_CAPABILITIES.start, (raw) => {
    const workflows = [
      ...new Set(startConstraints.parse(raw).workflows),
    ].sort();
    for (const identity of workflows) {
      if (!registry.get(identity)) {
        throw new Error(`${identity} is not a registered workflow`);
      }
    }
    return { workflows };
  });
}

function startCapability(
  host: ExecutionHost,
  registry: WorkflowRegistry
): WorksCapability {
  const capability = EXECUTION_CAPABILITIES.start;
  return defineUnary({
    capability,
    documentation:
      'Start a host-registered workflow with validated input. The approved constraints `{ workflows: ["id@version"] }` name the workflows this Module may start. The host runs it, with its own credentials, on this Module\'s workflows queue.',
    input: fields({
      input: required(z.unknown(), described("The workflow's input.")),
      request: required(
        z.string().min(1).max(200),
        text(
          "Your id for this start (at most 200 characters): resending it returns the same execution; reusing it for other input is refused."
        )
      ),
      version: required(
        z.number().int().positive(),
        portable({ description: "The workflow's version.", type: "integer" })
      ),
      workflow: required(
        z.string().min(1).max(200),
        text("A host-registered workflow id, such as works.text.summarize.")
      ),
    }),
    invoke(request, { principal }, { digest, value }) {
      const identity = workflowIdentity(request.workflow, request.version);
      if (!value.workflows.includes(identity)) {
        throw denied(`Starting ${identity} is not approved`);
      }
      // Checked again when the start takes its turn: a revoke that
      // committed first refuses it.
      return host.workflows.start(principal, request, async () => {
        await authorizeRuntime(host.modules, principal, [
          { capability, digest },
        ]);
      });
    },
    output: object(
      {
        execution: executionField,
        retried: portable({
          description: "Answered from an earlier start of this request.",
          type: "boolean",
        }),
        status,
      },
      ["execution", "retried", "status"]
    ),
    policy: startPolicy(registry),
    // Revoking the start Grant cancels what the Installation started.
    revoked: ({ installationId }) =>
      host.workflows.cancelInstallation(installationId),
    scope: { area: "workflows", of: ({ workflows }) => workflows },
  });
}

function watchCapability(host: ExecutionHost): WorksCapability {
  const capability = EXECUTION_CAPABILITIES.watch;
  return defineStream({
    capability,
    documentation:
      "Watch an execution this app started: a snapshot, then each change, ending once it completes, fails or is cancelled. Reconnect for a fresh snapshot.",
    event: object(
      {
        error: described(
          "Why it did not complete, as `{ code, message? }`; null otherwise."
        ),
        execution: executionField,
        kind: portable({ enum: ["snapshot", "update"], type: "string" }),
        output: described(
          "The workflow's answer once complete; null otherwise."
        ),
        progress: described("Where the workflow has got to, or null."),
        revision: portable({
          description: "Increases with every change; a repeat is never sent.",
          type: "integer",
        }),
        status,
        workflow: text("The workflow, as `id@version`."),
      },
      [
        "error",
        "execution",
        "kind",
        "output",
        "progress",
        "revision",
        "status",
        "workflow",
      ]
    ),
    input: executionInput,
    invoke: (request, { principal, signal }) =>
      host.workflows.watch(principal, request.execution, signal),
    policy: ownOnly(capability),
  });
}

function cancelCapability(host: ExecutionHost): WorksCapability {
  const capability = EXECUTION_CAPABILITIES.cancel;
  return defineUnary({
    capability,
    documentation:
      "Cancel an execution this app started. A finished one keeps its outcome.",
    input: executionInput,
    invoke: (request, { principal }) =>
      host.workflows.cancel(principal, request.execution),
    output: object({ status }, ["status"]),
    policy: ownOnly(capability),
  });
}

/** The three execution capabilities over `host`, starting `registry`'s workflows. */
export function executionCapabilities(
  host: ExecutionHost,
  registry: WorkflowRegistry = WORKS_WORKFLOWS
): WorksCapability[] {
  return [
    startCapability(host, registry),
    watchCapability(host),
    cancelCapability(host),
  ];
}
