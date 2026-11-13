import fs from "node:fs";
import ts from "typescript";
import { dirname, join } from "#path";
import type { FileMapCruiseInput } from "./file-map-cruise";
import { cruiseEntries } from "./module-cruise";
import type { CruisedModule } from "./module-graph";

// The isolated file-map cruise engine. It runs only inside a bundle
// `scripts/build.ts` builds with `browser-cruise-adapter.ts`, where
// `node:fs` is a memfs volume private to the bundle: dist/engine, which Bun
// loads (`file-map-cruise.ts`), and the browser analysis asset, which
// inlines this module through the `spyglass-browser` condition. Each cruise writes the map
// into the empty volume, cruises it with the native options
// (`module-cruise.ts`) and clears the volume, so a relative escape, an
// absolute import, a package lookup, a path alias or an `extends` can only
// ever find the map's own files. Cruises run one at a time, each from an
// empty volume, so concurrent callers never see each other's maps. The
// cruiser's TypeScript stays an import in dist/engine and is bundled into
// the browser asset.
// Unbundled, `node:fs` is the real file system, so the engine refuses to run.

/** The bundle's handle on its private volume; absent on any real `node:fs`. */
interface IsolatedVolume {
  reset(): void;
}

/** TypeScript's internal directory matcher, which `ts.sys` also uses. */
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

/** The `code` of an error for an explicit tsconfig the cruise refuses. */
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
  // As dependency-cruiser's extract-ts-config, which refuses natively.
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

/**
 * The explicit tsconfig as dependency-cruiser's extract-ts-config parses it
 * natively, through the volume: errors refuse the cruise, `extends` and
 * `include` see only the map.
 */
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
      // As `synthesizeTsconfig`: beside the root, so never cruised.
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

/** Cruise a file map in the empty private volume, after any running cruise. */
export function cruiseFileMap(
  input: FileMapCruiseInput
): Promise<CruisedModule[]> {
  const run = queue.then(() => cruiseIsolated(input));
  queue = run.catch(() => undefined);
  return run;
}
