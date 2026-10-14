import { writeFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConfigFile, ConfigWorkerReport } from "./spyglass-config";
import { configFiles, parseConfigFile } from "./spyglass-config";

// Loads a workspace's configuration files in a process of their own, so each
// load imports them fresh, and reports their validated default exports as
// JSON, which the loader validates again. Always run by Bun, which imports
// TypeScript as it is. Before each import the report names the file, so a
// file that ends the process is still named.
//
//   bun src/lib/config-worker.ts <workspace root> <report file> <configuration directory>

const [root, out, directory] = process.argv.slice(2);
if (root === undefined || out === undefined || directory === undefined) {
  throw new Error("config-worker needs <root> <out> <directory>");
}
const reportFile = out;

function report(value: ConfigWorkerReport): void {
  writeFileSync(reportFile, JSON.stringify(value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadFile(workspace: string, path: string): Promise<ConfigFile> {
  const file = relative(workspace, path).split(sep).join("/");
  report({ loading: file });
  let loaded: Record<string, unknown>;
  try {
    loaded = await import(pathToFileURL(path).href);
  } catch (error) {
    throw new Error(
      `Configuration ${file}: loading the file threw: ${messageOf(error)}`,
      { cause: error }
    );
  }
  if (!("default" in loaded)) {
    throw new Error(
      `Configuration ${file}: the file has no default export. Export the configuration as the default, or start a helper file's name with _.`
    );
  }
  return { config: checkedExport(loaded.default, file), file };
}

/** The file's default export, validated; anything that goes wrong is named by the file. */
function checkedExport(value: unknown, file: string): ConfigFile["config"] {
  try {
    return parseConfigFile(value, file);
  } catch (error) {
    const message = messageOf(error);
    if (message.startsWith(`Configuration ${file}:`)) {
      throw error;
    }
    throw new Error(
      `Configuration ${file}: checking the default export threw: ${message}`,
      { cause: error }
    );
  }
}

async function load(
  workspace: string,
  config: string
): Promise<ConfigWorkerReport> {
  try {
    const files: ConfigFile[] = [];
    for (const path of configFiles(config)) {
      files.push(await loadFile(workspace, path));
    }
    return { files };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

report(await load(root, directory));
// A configuration file may leave timers or handles open; the report is written.
process.exit(0);
