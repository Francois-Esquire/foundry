import { InMemoryFileSystemHost, Project, ts } from "ts-morph";
import { dirname, isAbsolute, join, normalize, relative } from "#path";
import {
  boundaryEntrypoints,
  expandPattern,
  manifestOwnerAt,
  normalizeWorkspacePath,
  ownerByManifests,
  packagePathAliases,
  resolveBoundary,
  workspaceMemberDirs,
  workspacePathAliases,
  workspacePatterns,
} from "./boundary-manifest";
import type {
  DirectoryOwnership,
  DirectoryVerdict,
  SourceOwner,
} from "./boundary-model";
import { ownerResult, toPosix } from "./boundary-model";
import type { AnalysisConfig } from "./config";
import type { FileMapCapabilities } from "./dataset-analysis";
import type { DependencyInventory } from "./dependency-inventory-types";
import {
  collectDependencyInventoryWith,
  resolveDependencyGraphWith,
} from "./dependency-rules";
import { discoverUnitsWith, workspaceRootName } from "./discovery-rules";
import { cruiseFileMap, TsconfigRefusedError } from "./file-map-cruise";
import type { FoldReader } from "./fold-inputs";
import { noFoldInputs, readFoldInputsWith } from "./fold-inputs";
import type { GitHistory } from "./git-history";
import type { Ignorer } from "./ignore-rules";
import { createIgnorerFrom } from "./ignore-rules";
import { cruisedPaths } from "./module-graph";
import type { PreparedPackageSource } from "./package-local-analysis";
import { tsconfigPathsInto } from "./package-local-analysis";
import type { PackageLocalReport } from "./package-local-types";
import type { SemanticsDiscovery } from "./semantics-types";
import {
  defaultWorkspaceCompilerOptions,
  globSources,
  packageSourceGlobs,
  workspaceProgramPaths,
  workspaceSourceGlobs,
} from "./source-files";
import type { AnalysisProfile } from "./types";
import type { PreparedWorkspaceInputs } from "./workspace-analysis";
import {
  analyzeWorkspaceToFolds,
  completeWorkspace,
  foldRequests,
} from "./workspace-analysis";
import type { WorkspaceSurfaceDerivation } from "./workspace-derive-types";
import {
  emptyOwnerTable,
  tableOwner,
  tableProgramOwners,
} from "./workspace-preparation";

export interface RepositoryFileMapInput {
  readonly declarations?: Readonly<Record<string, string>>;

  readonly exclude?: readonly string[];

  readonly files: Readonly<Record<string, string>>;
  readonly now: Date;
  readonly profile?: AnalysisProfile;

  readonly root: string;

  readonly tsconfig?: string;
}

export class FileMapInputError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[], options?: ErrorOptions) {
    super(`Invalid repository file map:\n- ${problems.join("\n- ")}`, options);
    this.name = "FileMapInputError";
    this.problems = problems;
  }
}

export interface PreparedFileMap {
  capabilities: FileMapCapabilities;

  discovery: SemanticsDiscovery;

  foldReads: { ignorer: Ignorer; reader: FoldReader };

  inventory: DependencyInventory | undefined;

  locals: PreparedPackageSource[];

  prepared: PreparedWorkspaceInputs;

  targets: string[];
  timing: Record<string, number>;

  workspaceName: string | undefined;
}

const DRIVE_SEGMENT = /^[A-Za-z]:/;
const TRAILING_SLASHES = /\/+$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const CONFIG_MODULE = /(^|\/)[^/]+\.config\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SCRIPT_MODULE = /\.(js|mjs|cjs|jsx)$/;
const BARE_SPECIFIER = /^[^./]/;

const REFERENCE_EXTENSIONS = ["", ".ts", ".tsx", ".d.ts"];
const NO_INPUTS_DIAGNOSTIC = 18_003;

export function pathProblems(path: string): string[] {
  if (path === "") {
    return ["an empty path"];
  }
  const problems: string[] = [];
  if (path.includes("\0")) {
    problems.push(`${JSON.stringify(path)} contains NUL`);
  }
  if (path.includes("\\")) {
    problems.push(
      `${JSON.stringify(path)} contains a backslash; paths are POSIX`
    );
  }
  if (path.startsWith("/") || DRIVE_SEGMENT.test(path)) {
    problems.push(
      `${JSON.stringify(path)} is absolute; paths are repository-relative`
    );
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    problems.push(
      `${JSON.stringify(path)} has an empty, "." or ".." segment (traversal or unnormalized)`
    );
  }
  if (segments.includes(".git")) {
    problems.push(
      `${JSON.stringify(path)} is inside .git; Git data is not accepted`
    );
  }
  return problems;
}

function rootProblems(root: unknown): string[] {
  if (typeof root !== "string") {
    return ["root must be a string"];
  }
  if (
    !root.startsWith("/") ||
    root.includes("\\") ||
    root.includes("\0") ||
    root === "/" ||
    normalize(root) !== root ||
    root.endsWith("/")
  ) {
    return [
      `root ${JSON.stringify(root)} must be a normalized POSIX absolute directory other than "/"`,
    ];
  }
  return [];
}

function textProblems(path: string, text: unknown): string[] {
  return [
    ...pathProblems(path),
    ...(typeof text === "string"
      ? []
      : [`${JSON.stringify(path)} is not text`]),
  ];
}

function fileProblems(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files).flatMap(([path, text]) => [
    ...textProblems(path, text),
    ...(path.split("/").includes("node_modules")
      ? [
          `${JSON.stringify(path)} is below node_modules; supply dependency declarations through declarations`,
        ]
      : []),
  ]);
}

function declarationProblems(
  declarations: Readonly<Record<string, string>>,
  files: Readonly<Record<string, string>>
): string[] {
  return Object.entries(declarations).flatMap(([path, text]) => [
    ...textProblems(path, text),
    ...(path.startsWith("node_modules/") &&
    (DECLARATION_FILE.test(path) || path.endsWith("/package.json"))
      ? []
      : [
          `declaration ${JSON.stringify(path)} must be a .d.ts, .d.mts, .d.cts or package.json file below node_modules/`,
        ]),
    ...(path in files
      ? [`${JSON.stringify(path)} is both a file and a declaration`]
      : []),
  ]);
}

export function collisionProblems(paths: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const folded = new Map<string, string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined) {
      problems.push(
        `${JSON.stringify(other)} and ${JSON.stringify(path)} differ only in case`
      );
    }
    folded.set(key, path);
    const segments = path.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      const prefix = segments.slice(0, end).join("/");
      if (paths.has(prefix)) {
        problems.push(
          `${JSON.stringify(prefix)} is a file and a directory of ${JSON.stringify(path)}`
        );
      }
    }
  }
  return problems;
}

function excludeProblems(exclude: unknown): string[] {
  if (exclude === undefined) {
    return [];
  }
  if (!Array.isArray(exclude)) {
    return ["exclude must be a list of workspace-relative directories"];
  }
  return exclude.flatMap((path) =>
    typeof path === "string" && normalizeWorkspacePath(path) === path
      ? []
      : [
          `exclude ${JSON.stringify(path)} must be a normalized workspace-relative directory`,
        ]
  );
}

function tsconfigProblems(input: RepositoryFileMapInput): string[] {
  if (input.tsconfig === undefined) {
    return [];
  }
  const problems = pathProblems(input.tsconfig);
  if (problems.length > 0) {
    return problems.map((problem) => `tsconfig: ${problem}`);
  }
  return input.tsconfig in input.files
    ? []
    : [`tsconfig ${JSON.stringify(input.tsconfig)} is not in the file map`];
}

export function fileMapProblems(input: RepositoryFileMapInput): string[] {
  const declarations = input.declarations ?? {};
  return [
    ...rootProblems(input.root),
    ...(input.now instanceof Date && !Number.isNaN(input.now.getTime())
      ? []
      : ["now must be a valid Date"]),
    ...fileProblems(input.files),
    ...declarationProblems(declarations, input.files),
    ...collisionProblems(
      new Set([...Object.keys(input.files), ...Object.keys(declarations)])
    ),
    ...tsconfigProblems(input),
    ...excludeProblems(input.exclude),
  ];
}

interface MappedRepository {
  directories: Set<string>;
  files: Map<string, string>;
  reader: FoldReader;
}

function enoent(path: string, operation: string): Error {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, ${operation} '${path}'`),
    { code: "ENOENT" }
  );
}

function mapRepository(
  root: string,
  input: RepositoryFileMapInput
): MappedRepository {
  const files = new Map<string, string>();
  const directories = new Set<string>([root]);
  const children = new Map<string, Map<string, boolean>>();
  const add = (rel: string, text: string) => {
    const absolute = join(root, rel);
    files.set(absolute, text);
    let child = absolute;
    let directory = false;
    for (;;) {
      const parent = child.slice(0, child.lastIndexOf("/")) || "/";
      let entries = children.get(parent);
      if (entries === undefined) {
        entries = new Map();
        children.set(parent, entries);
      }
      entries.set(child.slice(parent.length + 1), directory);
      if (parent === root || directories.has(parent)) {
        directories.add(parent);
        break;
      }
      directories.add(parent);
      child = parent;
      directory = true;
    }
  };
  for (const [rel, text] of Object.entries(input.files)) {
    add(rel, text);
  }
  for (const [rel, text] of Object.entries(input.declarations ?? {})) {
    add(rel, text);
  }

  const key = (path: string) =>
    path === "/" ? path : normalize(path).replace(TRAILING_SLASHES, "");
  const entriesOf = (path: string) => {
    const dir = key(path);
    if (files.has(dir)) {
      throw Object.assign(
        new Error(`ENOTDIR: not a directory, scandir '${path}'`),
        { code: "ENOTDIR" }
      );
    }
    if (!directories.has(dir)) {
      throw enoent(path, "scandir");
    }
    return [...(children.get(dir) ?? new Map<string, boolean>())]
      .map(([name, directory]) => ({ directory, name }))
      .sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
  };
  const reader: FoldReader = {
    childDirectories: (dir) =>
      entriesOf(dir)
        .filter((entry) => entry.directory)
        .map((entry) => join(dir, entry.name)),
    entries: entriesOf,
    exists: (path) => files.has(key(path)) || directories.has(key(path)),
    isDirectory: (path) => directories.has(key(path)),
    readConfigText: (file) => files.get(key(file)),
    readFile: (path) => {
      const text = files.get(key(path));
      if (text === undefined) {
        throw enoent(path, "open");
      }
      return text;
    },
    realpath: (path) => {
      const real = key(path);
      if (!(files.has(real) || directories.has(real))) {
        throw enoent(path, "realpath");
      }
      return real;
    },
  };
  return { directories, files, reader };
}

function mapDirectoryOwnership(
  root: string,
  repository: MappedRepository,
  members: Set<string> | null
): DirectoryOwnership {
  const verdicts = new Map<string, DirectoryVerdict>();
  const unwalked = new Set<string>();
  for (const dir of [...repository.directories].sort()) {
    if (dir === root) {
      continue;
    }
    const segments = relative(root, dir).split("/");
    const skipped = segments.findIndex(
      (segment) => segment === "node_modules" || segment === ".git"
    );
    if (skipped !== -1) {
      unwalked.add(join(root, ...segments.slice(0, skipped + 1)));
      continue;
    }
    if (!repository.files.has(join(dir, "package.json"))) {
      continue;
    }
    try {
      const owner = manifestOwnerAt(repository.reader, root, members, dir);
      if (owner !== undefined) {
        verdicts.set(dir, { owner });
      }
    } catch (error) {
      verdicts.set(dir, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { root, unwalked, verdicts };
}

function lapper(timing: Record<string, number>) {
  let started = performance.now();
  return (phase: string): number => {
    const now = performance.now();
    const elapsed = now - started;
    timing[phase] = elapsed;
    started = now;
    return elapsed;
  };
}

function createFileMapProject(
  root: string,
  repository: MappedRepository,
  ignorer: Ignorer,
  tsconfig: string | undefined
): {
  configDiagnostics: string[];
  project: Project;
  typesOptionSource: "tsconfig" | "policy-empty";
} {
  const fileSystem = new InMemoryFileSystemHost();
  for (const [path, text] of repository.files) {
    fileSystem.writeFileSync(path, text);
  }
  let project: Project;
  try {
    project =
      tsconfig === undefined
        ? new Project({
            compilerOptions: defaultWorkspaceCompilerOptions(),
            fileSystem,
          })
        : new Project({
            fileSystem,
            skipAddingFilesFromTsConfig: true,
            tsConfigFilePath: join(root, tsconfig),
          });
  } catch (error) {
    throw new FileMapInputError(
      [
        `tsconfig ${JSON.stringify(tsconfig)} cannot be parsed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      { cause: error }
    );
  }
  const configDiagnostics = project
    .getConfigFileParsingDiagnostics()
    .filter((diagnostic) => diagnostic.getCode() !== NO_INPUTS_DIAGNOSTIC)
    .map((diagnostic) => {
      const text = diagnostic.getMessageText();
      return `TS${diagnostic.getCode()}: ${typeof text === "string" ? text : text.getMessageText()}`;
    });
  const declaredTypes = project.getCompilerOptions().types;
  if (declaredTypes === undefined) {
    project.compilerOptions.set({ types: [] });
  }
  project.compilerOptions.set(
    workspaceProgramPaths(
      root,
      project.getCompilerOptions(),
      workspacePathAliases(repository.reader, root)
    )
  );
  // Add each path literally so names such as [id].ts are not interpreted as globs.

  for (const file of globSources(
    root,
    workspaceSourceGlobs(root, workspacePatterns(repository.reader, root)),
    project.getFileSystem(),
    ignorer
  )) {
    project.addSourceFileAtPath(file);
  }
  return {
    configDiagnostics,
    project,
    typesOptionSource:
      declaredTypes === undefined ? "policy-empty" : "tsconfig",
  };
}

function matchesAmbient(name: string, ambient: readonly string[]): boolean {
  return ambient.some((declared) => {
    const star = declared.indexOf("*");
    if (star === -1) {
      return declared === name;
    }
    const prefix = declared.slice(0, star);
    const suffix = declared.slice(star + 1);
    return (
      name.length >= prefix.length + suffix.length &&
      name.startsWith(prefix) &&
      name.endsWith(suffix)
    );
  });
}

function matchesAmbientPattern(
  name: string,
  ambient: readonly string[]
): boolean {
  return matchesAmbient(
    name,
    ambient.filter((declared) => declared.includes("*"))
  );
}

function ambientModuleNames(program: ts.Program): string[] {
  return program
    .getSourceFiles()
    .flatMap((file) =>
      ts.isExternalModule(file)
        ? []
        : file.statements.flatMap((statement) =>
            ts.isModuleDeclaration(statement) &&
            ts.isStringLiteral(statement.name)
              ? [statement.name.text]
              : []
          )
    );
}

function missingPathReferences(
  program: ts.Program,
  file: ts.SourceFile,
  info: ts.PreProcessedFileInfo
): string[] {
  return info.referencedFiles
    .map(({ fileName: name }) =>
      normalize(isAbsolute(name) ? name : join(dirname(file.fileName), name))
    )
    .filter(
      (target) =>
        !REFERENCE_EXTENSIONS.some(
          (extension) => program.getSourceFile(target + extension) !== undefined
        )
    );
}

function unresolvedTypeDirectives(
  file: ts.SourceFile,
  info: ts.PreProcessedFileInfo,
  options: ts.CompilerOptions,
  host: ts.ModuleResolutionHost
): string[] {
  return info.typeReferenceDirectives
    .map(({ fileName: name }) => name)
    .filter(
      (name) =>
        ts.resolveTypeReferenceDirective(name, file.fileName, options, host)
          .resolvedTypeReferenceDirective === undefined
    );
}

function unresolvedTypeReferences(
  root: string,
  project: Project
): { diagnostics: string[]; packages: string[] } {
  const program = project.getProgram().compilerObject;
  const options = program.getCompilerOptions();
  const host = project.getModuleResolutionHost();
  const files = program
    .getSourceFiles()
    .filter(
      (file) =>
        file.fileName.startsWith(`${root}/`) &&
        !CONFIG_MODULE.test(file.fileName)
    );
  const ambient = ambientModuleNames(program);
  const missing = new Set<string>();
  const diagnostics = new Set<string>();
  for (const file of files) {
    const declaration = DECLARATION_FILE.test(file.fileName);
    const from = relative(root, file.fileName);
    const resolves = (name: string) =>
      ts.resolveModuleName(
        name,
        file.fileName,
        options,
        host,
        undefined,
        undefined,
        file.impliedNodeFormat
      ).resolvedModule !== undefined;
    const info = ts.preProcessFile(
      file.text,
      true,
      SCRIPT_MODULE.test(file.fileName)
    );
    for (const { fileName: name } of info.importedFiles) {
      const bare = BARE_SPECIFIER.test(name);
      if (bare && !resolves(name) && !matchesAmbient(name, ambient)) {
        missing.add(name);
      } else if (
        !bare &&
        declaration &&
        !resolves(name) &&
        !matchesAmbientPattern(name, ambient)
      ) {
        diagnostics.add(`TS2307: Cannot find module '${name}' from '${from}'.`);
      }
    }
    for (const name of unresolvedTypeDirectives(file, info, options, host)) {
      missing.add(name);
    }
    if (declaration) {
      for (const target of missingPathReferences(program, file, info)) {
        diagnostics.add(
          `TS6053: File '${relative(root, target)}' referenced from '${from}' not found.`
        );
      }
    }
  }
  return {
    diagnostics: [...diagnostics].sort(),
    packages: [...missing].sort(),
  };
}

function cruiseLayout(
  reader: FoldReader,
  root: string
): { aliases: Record<string, string[]>; entries: string[] } {
  const patterns = workspacePatterns(reader, root);
  const entries = (patterns.length > 0 ? patterns : [""]).flatMap((pattern) =>
    pattern === ""
      ? ["."]
      : expandPattern(reader, root, pattern).map((dir) =>
          toPosix(relative(root, dir))
        )
  );
  const aliases: Record<string, string[]> = {};
  for (const [key, targets] of Object.entries(
    workspacePathAliases(reader, root)
  )) {
    aliases[key] = targets.map((target) => toPosix(relative(root, target)));
  }
  return { aliases, entries };
}

function prepareLocal(
  root: string,
  repository: MappedRepository,
  target: string,
  tsconfig: string | undefined,
  globber: Project,
  ignorer: Ignorer,
  ownerOf: SourceOwner
): PreparedPackageSource {
  const { reader } = repository;
  const boundary = resolveBoundary(reader, root, target);
  const ownTsconfig = join(boundary.dir, "tsconfig.json");
  const readText = (file: string) => repository.files.get(file);
  return {
    boundary,
    compilerPaths: {
      ...packagePathAliases(reader, boundary.dir),
      ...(reader.exists(ownTsconfig) &&
        tsconfigPathsInto(root, ownTsconfig, boundary, readText)),
      ...(tsconfig !== undefined &&
        tsconfigPathsInto(root, tsconfig, boundary, readText)),
    },
    entrypoints: boundaryEntrypoints(reader, boundary),
    files: globSources(
      root,
      packageSourceGlobs(boundary),
      globber.getFileSystem(),
      ignorer
    ).map((path) => ({
      ...ownerResult(ownerOf, path),
      path,
      text: reader.readFile(path),
    })),
    root,
  };
}

export function analyzeFileMapWorkspace(
  map: PreparedFileMap,
  locals: readonly PackageLocalReport[],
  config: AnalysisConfig | undefined,
  timing: Record<string, number>
): WorkspaceSurfaceDerivation {
  const { root } = map.prepared;
  let at = performance.now();
  const stage = analyzeWorkspaceToFolds(locals, map.prepared, config);
  let analysisMs = performance.now() - at;
  at = performance.now();
  const { destinations, sources } = foldRequests(stage);
  const fold =
    sources.length === 0
      ? noFoldInputs(root)
      : readFoldInputsWith(
          map.foldReads.reader,
          map.foldReads.ignorer,
          root,
          sources,
          destinations
        );
  timing.foldInputsMs = performance.now() - at;
  at = performance.now();
  const derivation = completeWorkspace(stage, fold);
  analysisMs += performance.now() - at;
  timing.workspaceAnalysisMs = analysisMs;
  return derivation;
}

export async function prepareFileMap(
  input: RepositoryFileMapInput
): Promise<PreparedFileMap> {
  const timing: Record<string, number> = {};
  const lap = lapper(timing);
  const problems = fileMapProblems(input);
  if (problems.length > 0) {
    throw new FileMapInputError(problems);
  }
  const { now, root, tsconfig } = input;
  const profile = input.profile ?? "full";
  const repository = mapRepository(root, input);
  const { reader } = repository;
  const ignorer = createIgnorerFrom((dir) =>
    repository.files.get(join(root, dir, ".gitignore"))
  );
  const members = workspaceMemberDirs(reader, root);
  const ownerCache = new Map<string, string>();
  const ownerOf: SourceOwner = (filePath) =>
    ownerByManifests(reader, root, members, filePath, ownerCache);
  const directories = mapDirectoryOwnership(root, repository, members);
  lap("validateAndMapMs");

  const discovery = discoverUnitsWith(reader, ignorer, root, {
    exclude: [...(input.exclude ?? [])],
  });
  const targets = discovery.units.map((unit) => unit.path);
  const inventory =
    discovery.declarationSource === undefined
      ? undefined
      : collectDependencyInventoryWith(reader, root, {
          ...discovery,
          declarationSource: discovery.declarationSource,
        });
  if (inventory !== undefined) {
    inventory.graph = resolveDependencyGraphWith(
      reader,
      root,
      inventory,
      ts.parseConfigFileTextToJson
    );
  }
  const workspaceName = workspaceRootName(reader, root);
  lap("discoveryMs");

  const { configDiagnostics, project, typesOptionSource } =
    createFileMapProject(root, repository, ignorer, tsconfig);
  const projectMs = lap("projectMs");

  const locals = targets.map((target) =>
    prepareLocal(root, repository, target, tsconfig, project, ignorer, ownerOf)
  );
  const packages = locals.map((local) => ({
    boundary: local.boundary,
    entrypoints: local.entrypoints,
  }));
  lap("localInputsMs");

  const program = project.getProgram().compilerObject;
  const typeReferences = unresolvedTypeReferences(root, project);
  const typeDiagnostics = [
    ...[
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
    ].map(
      (diagnostic) =>
        `TS${diagnostic.code}: ${typeof diagnostic.messageText === "string" ? diagnostic.messageText : diagnostic.messageText.messageText}`
    ),
    ...typeReferences.diagnostics,
  ];
  lap("programMs");

  const modules = await cruiseFileMap({
    ...cruiseLayout(reader, root),
    files: new Map([
      ...Object.entries(input.files),
      ...Object.entries(input.declarations ?? {}),
    ]),
    root,
    tsconfig,
  }).catch((error: unknown) => {
    if (error instanceof TsconfigRefusedError) {
      throw new FileMapInputError(
        [
          `tsconfig ${JSON.stringify(tsconfig)} is refused as native analysis refuses it: ${error.message.trim()}`,
        ],
        { cause: error }
      );
    }
    throw error;
  });
  const moduleGraphMs = lap("moduleGraphMs");

  const history: GitHistory =
    profile === "temporal"
      ? {
          analyzedAt: now.toISOString(),
          available: false,
          reason: "not-collected",
          root,
        }
      : {
          analyzedAt: now.toISOString(),
          available: false,
          reason: "not-git-repository",
          root,
        };

  const table = emptyOwnerTable();
  for (const file of project.getSourceFiles()) {
    tableOwner(table, file.getFilePath(), ownerOf);
  }
  tableProgramOwners(project, table, ownerOf);
  const ignored = new Map<string, boolean>();
  for (const absolute of cruisedPaths(root, modules)) {
    const rel = relative(root, absolute);
    if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) {
      continue;
    }
    const posix = toPosix(rel);
    ignored.set(posix, ignorer.ignores(posix));
    if (!absolute.includes("/node_modules/")) {
      tableOwner(table, absolute, ownerOf);
    }
  }
  lap("ownersMs");

  const relFiles = Object.keys(input.files).sort();
  const compilerOptions = project.getCompilerOptions();
  const capabilities: FileMapCapabilities = {
    configuration: {
      configModules: relFiles.filter((path) => CONFIG_MODULE.test(path)),
      diagnostics: configDiagnostics,
      executed: false,
      tsconfig: tsconfig ?? null,
      unusedRootTsconfig:
        tsconfig !== "tsconfig.json" && "tsconfig.json" in input.files,
    },
    history: {
      available: false,
      detail: "A file map carries no Git history.",
      reason: "not-git-repository",
    },
    moduleGraph: {
      source: "dependency-cruiser",
      unresolved: modules.flatMap((mod) =>
        mod.dependencies
          .filter((dependency) => dependency.couldNotResolve)
          .map((dependency) => ({
            from: mod.source,
            specifier: dependency.resolved,
          }))
      ),
    },
    paths: { root, semantics: "posix" },
    types: {
      diagnostics: typeDiagnostics,
      policy: "explicit-declarations-and-bundled-libs",
      suppliedDeclarations: Object.keys(input.declarations ?? {}).sort(),
      typesOption: [...(compilerOptions.types ?? [])],
      typesOptionSource,
      unresolvedPackages: typeReferences.packages,
    },
  };
  lap("capabilitiesMs");

  return {
    capabilities,
    discovery,
    foldReads: { ignorer, reader },
    inventory,
    locals,
    prepared: {
      directories,
      history,
      moduleGraph: { ignored, modules },
      now,
      ownerErrors: table.errors,
      owners: table.owners,
      packages,
      profile,
      project,
      root,
      timing: {
        cruiseMs: Math.round(moduleGraphMs),
        historyMs: 0,
        projectMs: Math.round(projectMs),
      },
    },
    targets,
    timing,
    workspaceName,
  };
}
