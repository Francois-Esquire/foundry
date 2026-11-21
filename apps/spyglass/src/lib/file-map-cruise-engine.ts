import fs from "node:fs";
import ts from "typescript";
import { dirname, join } from "#path";
import type { FileMapCruiseInput } from "./file-map-cruise";
import { cruiseEntries } from "./module-cruise";
import type { CruisedModule } from "./module-graph";

interface IsolatedVolume {
  reset(): void;
}

type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => {
    directories: readonly string[];
    files: readonly string[];
  },
  realpath: (path: string) => string
) => string[];

export const TSCONFIG_REFUSED = "spyglass-tsconfig-refused";

function isolatedVolume(): IsolatedVolume {
  const volume = (fs as unknown as { isolatedVolume?: IsolatedVolume })
    .isolatedVolume;
  if (volume === undefined) {
    throw new Error(
      "The file-map cruise runs only in its isolated engine bundle (dist/engine), never against the real file system."
    );
  }
  return volume;
}

function refused(diagnostics: readonly ts.Diagnostic[], root: string): Error {
  const message = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  });
  return Object.assign(new Error(message), { code: TSCONFIG_REFUSED });
}

function readFile(path: string): string | undefined {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : undefined;
}

function entries(path: string) {
  const directories: string[] = [];
  const files: string[] = [];
  if (fs.existsSync(path) && fs.statSync(path).isDirectory()) {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      (entry.isDirectory() ? directories : files).push(String(entry.name));
    }
  }
  return { directories: directories.sort(), files: files.sort() };
}

function parsedTsconfig(file: string, root: string): ts.ParsedCommandLine {
  const { config, error } = ts.readConfigFile(file, readFile);
  if (error !== undefined) {
    throw refused([error], root);
  }
  const { matchFiles } = ts as unknown as { matchFiles?: MatchFiles };
  if (matchFiles === undefined) {
    throw new Error("This TypeScript no longer provides matchFiles.");
  }
  const parsed = ts.parseJsonConfigFileContent(
    config,
    {
      fileExists: (path) => fs.existsSync(path) && fs.statSync(path).isFile(),
      readDirectory: (path, extensions, excludes, includes, depth) =>
        matchFiles(
          path,
          extensions,
          excludes,
          includes,
          true,
          root,
          depth,
          entries,
          (real) => real
        ),
      readFile,
      useCaseSensitiveFileNames: true,
    },
    dirname(file),
    {},
    file
  );
  if (parsed.errors.length > 0) {
    throw refused(parsed.errors, root);
  }
  return parsed;
}

async function cruiseIsolated(
  input: FileMapCruiseInput
): Promise<CruisedModule[]> {
  const volume = isolatedVolume();
  const { root } = input;
  volume.reset();
  try {
    for (const [path, text] of input.files) {
      const file = join(root, path);
      fs.mkdirSync(dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    let tsconfigFile: string;
    let transpileTsConfig: unknown;
    if (input.tsconfig === undefined) {
      const compilerOptions = { baseUrl: root, paths: input.aliases };
      tsconfigFile = `${root}.spyglass-tsconfig.json`;
      fs.writeFileSync(tsconfigFile, JSON.stringify({ compilerOptions }));
      transpileTsConfig = { options: compilerOptions };
    } else {
      tsconfigFile = join(root, input.tsconfig);
      transpileTsConfig = parsedTsconfig(tsconfigFile, root);
    }
    return await cruiseEntries(
      root,
      input.entries.filter((entry) => fs.existsSync(join(root, entry))),
      tsconfigFile,
      transpileTsConfig
    );
  } finally {
    volume.reset();
  }
}

let queue: Promise<unknown> = Promise.resolve();

export function cruiseFileMap(
  input: FileMapCruiseInput
): Promise<CruisedModule[]> {
  const run = queue.then(() => cruiseIsolated(input));
  queue = run.catch(() => undefined);
  return run;
}
