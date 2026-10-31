import path from "node:path";
import type { ModuleVersion } from "@foundry/modules/domain";
import type { ModulePrincipal } from "@foundry/modules/gateway/types";
import type { WorksExecution } from "~/main/execution/contract";
import { SystemTheme } from "~/main/system/theme";
import { composeWorks } from "~/main/works";
import { scriptedModels } from "./authoring-model";
import { successfulBuildRuntime } from "./module-build";
import { fakeContainerRuntime } from "./module-sandboxes";

/** A planted secret: no audit payload or run-store file may contain it. */
export const SCENARIO_PROMPT =
  "Rename the app to Weather (planted-prompt-7f3a)";
export const SCENARIO_FILE_BODY = "# Field notes (planted-body-91c2)\n";
export const SCENARIO_SOURCE_BODY = "planted-source-55d0";

const APP = "packages/app/src/App.tsx";

/**
 * One Works session through Works composed as main composes it, over a
 * JSON engine store in `directory`: Module create, source saves (one
 * stale), a build whose publish is its child run, a settings change, File
 * Artifact create/save/conflict, a Program lifetime with a Gateway
 * invocation, a scripted chat turn (model turns and tool calls), and a
 * registered workflow. Only the VMs, the build and the model are stand-ins.
 * The caller closes it.
 */
export async function runAuditScenario(directory: string) {
  const { models } = scriptedModels([
    {
      tools: [
        {
          input: {
            content: "export const App = () => 'Weather';\n",
            file_path: `/workspace/${APP}`,
          },
          name: "write",
        },
      ],
    },
    { text: "Renamed the app." },
  ]);
  const { runtime: containers } = fakeContainerRuntime();
  const works = await composeWorks({
    artifactRoot: path.join(directory, "artifacts"),
    builds: () => successfulBuildRuntime,
    containers: () => Promise.resolve(containers),
    models,
    moduleRoot: path.join(directory, "modules"),
    print: () => undefined,
    programs: () =>
      Promise.resolve({
        revoked: () => undefined,
        shutdown: () => Promise.resolve(),
        start: (_version: ModuleVersion) =>
          Promise.resolve({
            close: () => Promise.resolve(),
            origin: "http://127.0.0.1:3000",
          }),
      }),
    routes: {
      route: () => ({ model: "scripted/coder", provider: "scripted" }),
    },
    theme: new SystemTheme(),
    userData: directory,
  });
  const { modules: library } = works.rpc;
  const { calls, execution, files } = works.testing;

  const module = await library.create("Weather desk");
  const details = await library.details(module.id);
  if (!details?.binding) {
    throw new Error("Starter binding missing");
  }
  const saved = await library.saveSource(
    module.id,
    { ...details.source, "README.md": `# ${SCENARIO_SOURCE_BODY}\n` },
    details.binding
  );
  // A stale save: a failed attempt, never a save.
  await library
    .saveSource(module.id, details.source, details.binding)
    .catch(() => undefined);
  for await (const _event of works.rpc.builds.watch(
    module.id,
    "0.1.0",
    saved
  )) {
    // Drained to completion.
  }
  await works.rpc.moduleSettings.set(module.id, { "audit.retentionDays": 14 });

  const created = await files.create({
    actor: { kind: "user" },
    bytes: new TextEncoder().encode(SCENARIO_FILE_BODY),
    mime: "text/markdown",
    name: "Field notes",
    path: "notes.md",
  });
  if (created.kind !== "created") {
    throw new Error("File not created");
  }
  await files.save({
    actor: { kind: "user" },
    artifactId: created.artifactId,
    expectedDigest: created.digest,
    path: "notes.md",
    text: `${SCENARIO_FILE_BODY}More.\n`,
  });
  // Edits against the old digest: a conflict, recorded as an attempt.
  await files.save({
    actor: { kind: "user" },
    artifactId: created.artifactId,
    expectedDigest: created.digest,
    path: "notes.md",
    text: "conflicting",
  });

  const release = (await library.details(module.id))?.releases[0];
  if (!release) {
    throw new Error("Release missing");
  }
  const principal = {
    contentId: release.contentId,
    generation: 1,
    installationId: module.id,
    moduleId: module.id,
    runtimeInstanceId: "runtime-1",
  } as unknown as ModulePrincipal;
  const app = works.rpc.sessions.watch(module.id, release.contentId);
  await app.next();
  const startedAt = new Date().toISOString();
  calls.record({
    capability: { name: "works.system.theme", version: 1 },
    endedAt: new Date().toISOString(),
    invocationId: "runtime:runtime-1:request:1",
    mode: "unary",
    principal,
    startedAt,
    status: "complete",
  });
  calls.record({
    capability: { name: "works.artifacts.save", version: 1 },
    endedAt: new Date().toISOString(),
    errorCode: "unauthorized",
    invocationId: "runtime:runtime-1:request:2",
    mode: "unary",
    principal,
    startedAt,
    status: "denied",
  });
  const ticker = await works.testing.workflows.start(principal, {
    input: { count: 2, intervalMs: 0 },
    request: "tick-1",
    version: 1,
    workflow: "works.examples.ticker",
  });
  await settledRun(execution, ticker.execution);
  await app.return();

  const chat = await library.create("Chat test");
  const chatDetails = await library.details(chat.id);
  if (!chatDetails?.binding) {
    throw new Error("Starter binding missing");
  }
  const turn = await works.rpc.authoring.send(chat.id, {
    binding: chatDetails.binding,
    prompt: SCENARIO_PROMPT,
    source: chatDetails.source,
  });
  const turnRun = await waitFor(() =>
    execution.runs
      .list()
      .find(
        (run) =>
          run.correlation.turnId === turn.id &&
          ["complete", "failed", "cancelled"].includes(run.status)
      )
  );
  return {
    artifactId: created.artifactId,
    chatModuleId: chat.id,
    /** Closes the composed Works, its engine last. */
    close: () => works.close(),
    execution,
    library,
    moduleId: module.id,
    turnRunId: turnRun.id,
    workflowRunId: ticker.execution,
    works,
  };
}

async function waitFor<T>(find: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const found = find();
    if (found !== undefined) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The scenario did not get there");
}

function settledRun(execution: Pick<WorksExecution, "runs">, id: string) {
  return waitFor(() => {
    const run = execution.runs.get(id);
    return run && ["complete", "failed", "cancelled"].includes(run.status)
      ? run
      : undefined;
  });
}
