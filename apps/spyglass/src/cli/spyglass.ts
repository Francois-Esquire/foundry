#!/usr/bin/env bun
import type { CheckResult } from "../lib/check";
import { check } from "../lib/check";
import { planSite } from "../lib/codemod";
import { applyRecord, InterruptedError } from "../lib/codemod-apply";
import type { ApplyResult } from "../lib/codemod-types";
import { savedDataset } from "../lib/dataset-files";
import { exportCollection, exportViewer } from "../lib/export";
import {
  renderApply,
  renderLens,
  renderPlan,
  renderSurface,
} from "../lib/render";
import type { RenderContext } from "../lib/render/context";
import type {
  CollectionProgressEvent,
  CollectionScan,
  Scan,
  ScanProgressEvent,
  WorkspaceScan,
} from "../lib/scan";
import { scan } from "../lib/scan";
import type { CollectionServer, SpyglassServer } from "../lib/serve";
import { serve, viewerRoot } from "../lib/serve";
import type { ArgsOf, Command, Workspaces } from "./args";
import {
  HELP,
  messageOf,
  parseArguments,
  UsageError,
  workspacesOf,
} from "./args";
import { openBrowser } from "./browser";

/** Exit codes: `check` exits 3 on a violation, so that a broken rule is told from a failed run. */
const FAILED = 1;
const BAD_ARGUMENTS = 2;
const VIOLATIONS = 3;
/** 128 + the signal's number, as a shell reports a command a signal stopped; apply exits so once it restored its write. */
const INTERRUPTED: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

/** `check`'s exit code: a rule it could not check outranks a broken one. */
const CHECK_EXIT: Record<CheckResult["outcome"], number> = {
  clean: 0,
  incomplete: FAILED,
  violations: VIOLATIONS,
};
/** `apply`'s exit code: 0 only for a preview, or a write that verified and whose scan published. */
function applyExit(result: ApplyResult): number {
  const done =
    result.status === "preview" ||
    (result.status === "applied" && result.scan?.status === "published");
  return done ? 0 : FAILED;
}

/** The report's width when stdout is not a terminal. */
const PIPED_WIDTH = 80;

function print(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** A command's result on stdout: its library value as one line of JSON with `--json`, else the text for people. */
function printResult(
  { json }: { json: boolean },
  value: unknown,
  text: () => string
): void {
  print(json ? JSON.stringify(value) : text());
}

/** Phases, then one line per package's internals, on stderr; the rest is for programs. */
function printProgress(event: ScanProgressEvent): void {
  if (event.kind === "phase") {
    process.stderr.write(
      `${event.phase}${event.detail ? `: ${event.detail}` : ""}\n`
    );
  } else if (event.kind === "internals") {
    process.stderr.write(`internals: ${event.package}\n`);
  }
}

/**
 * A collection's progress: a `workspace: <root>` line when the next
 * workspace's scan starts, then that scan's lines as for one workspace.
 */
function collectionProgress(): (event: CollectionProgressEvent) => void {
  let current: string | undefined;
  return ({ event, root }) => {
    if (root !== current) {
      current = root;
      process.stderr.write(`workspace: ${root}\n`);
    }
    printProgress(event);
  };
}

const savedLine = (saved: WorkspaceScan) => `Dataset saved to ${saved.output}`;

/** One saved line per workspace, then what ties them. */
const collectionLines = (saved: CollectionScan) =>
  [
    ...saved.workspaces.map(savedLine),
    `Collection: ${saved.workspaces.length} workspaces, ${saved.manifest.crossings.length} crossings`,
  ].join("\n");

const serverLines = (server: SpyglassServer | CollectionServer) =>
  [
    `Spyglass: ${server.url.href}`,
    ...("roots" in server ? server.roots : [server.root]).map(
      (root) => `Workspace: ${root}`
    ),
  ].join("\n");

/** A scan of the one workspace, or of each workspace of the collection. */
function scanned(
  args: ArgsOf<"open"> | ArgsOf<"scan">,
  workspaces: Workspaces
): Promise<CollectionScan | Scan> {
  const options = { history: args.history, state: args.state };
  if ("root" in workspaces) {
    return scan(workspaces.root, {
      ...options,
      onProgress: args.quiet ? undefined : printProgress,
    });
  }
  return scan.collection(workspaces.roots, {
    ...options,
    onProgress: args.quiet ? undefined : collectionProgress(),
  });
}

/** The server of the one workspace, or of the collection. */
function served(
  args: ArgsOf<"open"> | ArgsOf<"serve">,
  workspaces: Workspaces
): Promise<SpyglassServer | CollectionServer> {
  const options = { port: args.port, state: args.state };
  return "root" in workspaces
    ? serve(workspaces.root, options)
    : serve.collection(workspaces.roots, options);
}

/** The lines a scan prints: one workspace's, or a collection's. */
const scannedLines = (saved: CollectionScan | Scan) =>
  "workspaces" in saved ? collectionLines(saved) : savedLine(saved);

/** Runs until SIGINT or SIGTERM, which stop the server and exit 0. */
async function whileServing(
  server: Pick<SpyglassServer, "stop" | "url">,
  { "no-open": noOpen }: { "no-open": boolean }
): Promise<void> {
  const stop = () => server.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (noOpen) {
    return;
  }
  try {
    await openBrowser(server.url.href);
  } catch (error) {
    // Not a failure, and not progress: --quiet keeps it.
    process.stderr.write(`${messageOf(error)} Open ${server.url.href}\n`);
  }
}

function renderContext({
  density,
  format,
}: Pick<ArgsOf<"report">, "density" | "format">): Partial<RenderContext> {
  const terminal = process.stdout.isTTY === true;
  const chosen = format ?? (terminal ? "terminal" : "text");
  return {
    color: chosen === "terminal" && !process.env.NO_COLOR,
    density,
    format: chosen,
    unicode: true,
    width: terminal ? (process.stdout.columns ?? PIPED_WIDTH) : PIPED_WIDTH,
  };
}

const RUN: { readonly [C in Command]: (args: ArgsOf<C>) => Promise<void> } = {
  async apply(args) {
    const [root] = args.paths;
    const result = await applyRecord(root, args.site, {
      onProgress: args.quiet ? undefined : printProgress,
      state: args.state,
      write: args.write,
    });
    printResult(args, result, () => renderApply(result, renderContext(args)));
    process.exitCode = applyExit(result);
  },
  async check(args) {
    const [root] = args.paths;
    const result = await check(root, { state: args.state });
    printResult(args, result, () =>
      renderLens("rules", result.lens, renderContext(args))
    );
    const [first] = result.lens.missing;
    if (first !== undefined) {
      const more = result.lens.missing.length - 1;
      process.stderr.write(
        `Spyglass: rules[${first.rule}] meets ${first.package}, which failed analysis, so it could not be checked there${more > 0 ? ` (and ${more} more)` : ""}. Fix the package or narrow the rule's subject, then scan again.\n`
      );
    }
    process.exitCode = CHECK_EXIT[result.outcome];
  },
  async export(args) {
    const workspaces = await workspacesOf(args.paths);
    const options = { state: args.state };
    const written =
      "root" in workspaces
        ? await exportViewer(workspaces.root, args.directory, options)
        : await exportCollection(workspaces.roots, args.directory, options);
    printResult(
      args,
      written,
      () => `Static viewer saved to ${written.directory}`
    );
  },
  async lens(args) {
    const [root] = args.paths;
    const { reader } = await savedDataset(root, args.state);
    const output = await reader.lens(args.lens);
    printResult(args, output, () =>
      renderLens(args.lens, output, renderContext(args))
    );
  },
  async open(args) {
    const workspaces = await workspacesOf(args.paths);
    // Fail before the scan, not after it, when there is no viewer to open.
    await viewerRoot();
    const saved = await scanned(args, workspaces);
    if (!args.json) {
      print(scannedLines(saved));
    }
    const server = await served(args, workspaces);
    printResult(args, { ...saved, ...server }, () => serverLines(server));
    await whileServing(server, args);
  },
  // Every verdict is a result, refused and blocked included: exit 0.
  async plan(args) {
    const [root] = args.paths;
    const result = await planSite(root, args.site, { state: args.state });
    printResult(args, result, () => renderPlan(result, renderContext(args)));
  },
  async report(args) {
    const [root] = args.paths;
    const { reader } = await savedDataset(root, args.state);
    const report = await reader.packageReport(args.package);
    printResult(args, report, () => renderSurface(report, renderContext(args)));
  },
  async scan(args) {
    const saved = await scanned(args, await workspacesOf(args.paths));
    printResult(args, saved, () => scannedLines(saved));
  },
  async serve(args) {
    const server = await served(args, await workspacesOf(args.paths));
    printResult(args, server, () => serverLines(server));
    await whileServing(server, args);
  },
};

function run<C extends Command>(command: C, args: ArgsOf<C>): Promise<void> {
  const runner: (args: ArgsOf<C>) => Promise<void> = RUN[command];
  return runner(args);
}

async function main(): Promise<void> {
  const line = parseArguments(process.argv.slice(2));
  if (line.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  await run(line.command, line);
}

try {
  await main();
} catch (error) {
  const usage = error instanceof UsageError;
  process.stderr.write(
    `Spyglass: ${messageOf(error)}\n${usage ? "Run spyglass --help for usage.\n" : ""}`
  );
  if (usage) {
    process.exitCode = BAD_ARGUMENTS;
  } else {
    process.exitCode =
      error instanceof InterruptedError
        ? (INTERRUPTED[error.signal] ?? FAILED)
        : FAILED;
  }
}
