#!/usr/bin/env bun
import type { CheckResult } from "../lib/check";
import { check } from "../lib/check";
import { planSite } from "../lib/codemod";
import { applyRecord, InterruptedError } from "../lib/codemod-apply";
import type { ApplyResult } from "../lib/codemod-types";
import { savedDataset } from "../lib/dataset-files";
import { exportViewer } from "../lib/export";
import {
  renderApply,
  renderLens,
  renderPlan,
  renderSurface,
} from "../lib/render";
import type { RenderContext } from "../lib/render/context";
import type { ScanProgressEvent, WorkspaceScan } from "../lib/scan";
import { scan } from "../lib/scan";
import type { AtlasServer } from "../lib/serve";
import { serve, viewerRoot } from "../lib/serve";
import type { ArgsOf, Command } from "./args";
import { HELP, messageOf, parseArguments, UsageError } from "./args";
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

const savedLine = (saved: WorkspaceScan) => `Dataset saved to ${saved.output}`;

const serverLines = (server: AtlasServer) =>
  `Atlas: ${server.url.href}\nWorkspace: ${server.root}`;

function scanned(args: ArgsOf<"open"> | ArgsOf<"scan">) {
  const [root] = args.paths;
  return scan(root, {
    history: args.history,
    onProgress: args.quiet ? undefined : printProgress,
    state: args.state,
  });
}

/** Runs until SIGINT or SIGTERM, which stop the server and exit 0. */
async function whileServing(
  server: AtlasServer,
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
        `Atlas: rules[${first.rule}] meets ${first.package}, which failed analysis, so it could not be checked there${more > 0 ? ` (and ${more} more)` : ""}. Fix the package or narrow the rule's subject, then scan again.\n`
      );
    }
    process.exitCode = CHECK_EXIT[result.outcome];
  },
  async export(args) {
    const [root] = args.paths;
    const written = await exportViewer(root, args.directory, {
      state: args.state,
    });
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
    const [root] = args.paths;
    // Fail before the scan, not after it, when there is no viewer to open.
    await viewerRoot();
    const saved = await scanned(args);
    if (!args.json) {
      print(savedLine(saved));
    }
    const server = await serve(root, { port: args.port, state: args.state });
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
    const saved = await scanned(args);
    printResult(args, saved, () => savedLine(saved));
  },
  async serve(args) {
    const [root] = args.paths;
    const server = await serve(root, { port: args.port, state: args.state });
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
    `Atlas: ${messageOf(error)}\n${usage ? "Run atlas --help for usage.\n" : ""}`
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
