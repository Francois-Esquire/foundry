import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import nodeModule from "node:module";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withBunEvaluatingLoad } from "~/authoring/runtime";

const MARBLES_ROOT = realpathSync(
  fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../.." : "..", import.meta.url)
  )
);
const MARBLES_CODE = [join(MARBLES_ROOT, "src"), join(MARBLES_ROOT, "dist")];

const entryUrl = (srcPath: string, distFile: string): string =>
  new URL(
    import.meta.url.endsWith(".ts") ? srcPath : `./${distFile}`,
    import.meta.url
  ).href;

const PROVIDER_MODULES = ["claude-code", "codex", "gateway", "pi", "vercel"];

const SELF_URLS: ReadonlyMap<string, string> = new Map([
  ["@foundry.sh/marbles", entryUrl("../authoring/index.ts", "index.js")],
  [
    "@foundry.sh/marbles/engine",
    entryUrl("../entries/embedded.ts", "engine.js"),
  ],
  ["@foundry.sh/marbles/lib", entryUrl("../entries/lib.ts", "lib.js")],
  [
    "@foundry.sh/marbles/prebuilt",
    entryUrl("../authoring/prebuilt.ts", "prebuilt.js"),
  ],
  [
    "@foundry.sh/marbles/process",
    entryUrl("../process/index.ts", "process.js"),
  ],
  [
    "@foundry.sh/marbles/providers",
    entryUrl("../authoring/providers.ts", "providers.js"),
  ],
  [
    "@foundry.sh/marbles/statuses",
    entryUrl("../lib/execution-statuses.ts", "statuses.js"),
  ],
  [
    "@foundry.sh/marbles/workspace",
    entryUrl("../workspace/index.ts", "workspace.js"),
  ],
  ...PROVIDER_MODULES.map(
    (name) =>
      [
        `@foundry.sh/marbles/providers/${name}`,
        entryUrl(`../lib/providers/${name}.ts`, `providers/${name}.js`),
      ] as const
  ),
]);

const LOAD_PARAM = "marbles-load";
const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];
const INDEX_CANDIDATES = [
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.js",
  "index.jsx",
  "index.mjs",
];
const SCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const COMMONJS_EXTENSIONS = new Set([".cjs", ".cts"]);
const LOCAL_SPECIFIER_FILTER = /^(?:\.{1,2}(?:\/|$)|\/|file:)/;
const STATIC_SPECIFIER =
  /(?:^|[^\w$])(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"'\n]+)["']|(?:^|[^\w$])import\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const ESM_SYNTAX =
  /(?:^|[;\n])\s*(?:import(?:\s*(?:\{|\*|["'])|\s+[\w$])|export(?:\s*(?:\{|\*)|\s+(?:default|const|let|var|function|async|class|type|interface)\b))/;
const CJS_SYNTAX =
  /(?:^|[^\w$.])(?:module\.exports\b|exports\.[A-Za-z_$]|require\s*\()/;

export class CommonJsModuleError extends Error {
  override readonly name = "CommonJsModuleError";
}

export class UnsupportedLoaderRuntimeError extends Error {
  override readonly name = "UnsupportedLoaderRuntimeError";
}

export interface LoadSession {
  dispose(): void;
  readonly files: ReadonlySet<string>;
  importModule(file: string): Promise<Readonly<Record<string, unknown>>>;
}

export interface LoadSessionOptions {
  readonly read?: (file: string) => void;
}

interface SessionState {
  disposed: boolean;
  readonly files: Set<string>;
  readonly read?: (file: string) => void;
}

interface ResolveResult {
  readonly shortCircuit?: boolean;
  readonly url: string;
}

interface ResolveContext {
  readonly parentURL?: string;
}

interface LoadContext {
  readonly importAttributes?: Readonly<Record<string, string>>;
}

interface LoadResult {
  readonly format?: string;
  readonly shortCircuit?: boolean;
  readonly source?: string | Uint8Array;
}

export interface LoaderRuntimeProbe {
  readonly bunPlugin?: unknown;
  readonly registerHooks?: unknown;
}

interface RegisterHooksApi {
  readonly registerHooks?: (hooks: {
    load?: (
      url: string,
      context: LoadContext,
      nextLoad: (url: string, context: LoadContext) => LoadResult
    ) => LoadResult;
    resolve?: (
      specifier: string,
      context: ResolveContext,
      nextResolve: (specifier: string, context: ResolveContext) => ResolveResult
    ) => ResolveResult;
  }) => void;
}

interface BunPluginBuilder {
  module(
    specifier: string,
    callback: () =>
      | { readonly exports: Record<string, unknown>; readonly loader: "object" }
      | Promise<{
          readonly exports: Record<string, unknown>;
          readonly loader: "object";
        }>
  ): void;
  onResolve(
    options: { readonly filter: RegExp },
    callback: (args: {
      readonly importer: string;
      readonly path: string;
    }) => undefined
  ): void;
}

interface BunRuntimeGlobal {
  readonly Bun?: {
    readonly plugin?: (plugin: {
      readonly name: string;
      readonly setup: (builder: BunPluginBuilder) => void;
      readonly target?: string;
    }) => void;
  };
}

let sessionCounter = 0;
const activeSessions = new Map<number, SessionState>();
let linkedAdapter: Promise<"node" | "bun"> | undefined;

export function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInsideMarblesOrNodeModules(file: string): boolean {
  return (
    file.includes(`${sep}node_modules${sep}`) ||
    MARBLES_CODE.some(
      (directory) => file === directory || file.startsWith(`${directory}${sep}`)
    )
  );
}

function isExistingFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRelativeOrFileSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  );
}

function resolveCandidateFile(
  specifier: string,
  importerDir: string
): string | undefined {
  const raw = specifier.startsWith("file:")
    ? fileURLToPath(specifier)
    : specifier;
  const base = isAbsolute(raw) ? raw : resolve(importerDir, raw);
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (isExistingFile(candidate)) {
      return realPathOf(candidate);
    }
  }
  if (isExistingDirectory(base)) {
    for (const indexName of INDEX_CANDIDATES) {
      const candidate = join(base, indexName);
      if (isExistingFile(candidate)) {
        return realPathOf(candidate);
      }
    }
  }
}

function commonJsError(file: string): CommonJsModuleError {
  return new CommonJsModuleError(
    `cannot load CommonJS module "${file}": Marbles workspace sources must be ES modules (.ts, .mts, .js, .mjs)`
  );
}

function assertEsmWorkspaceFile(file: string, sourceText?: string): void {
  if (isInsideMarblesOrNodeModules(file)) {
    return;
  }
  const ext = extname(file).toLowerCase();
  if (COMMONJS_EXTENSIONS.has(ext)) {
    throw commonJsError(file);
  }
  if (ext !== ".js" && ext !== ".jsx") {
    return;
  }
  let text = sourceText;
  if (text === undefined) {
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
  }
  if (CJS_SYNTAX.test(text) && !ESM_SYNTAX.test(text)) {
    throw commonJsError(file);
  }
}

function recordSessionFile(session: SessionState, file: string): void {
  if (session.disposed || isInsideMarblesOrNodeModules(file)) {
    return;
  }
  if (!session.files.has(file)) {
    session.files.add(file);
    session.read?.(file);
  }
}

function collectStaticDeps(
  entry: string,
  visit: (file: string) => void,
  seen = new Set<string>()
): void {
  const real = realPathOf(entry);
  if (seen.has(real) || isInsideMarblesOrNodeModules(real)) {
    return;
  }
  seen.add(real);
  const ext = extname(real).toLowerCase();
  if (!SCRIPT_EXTENSIONS.has(ext)) {
    visit(real);
    return;
  }
  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    assertEsmWorkspaceFile(real);
    visit(real);
    return;
  }
  assertEsmWorkspaceFile(real, text);
  visit(real);
  const baseDir = dirname(real);
  STATIC_SPECIFIER.lastIndex = 0;
  let match = STATIC_SPECIFIER.exec(text);
  while (match !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined && isRelativeOrFileSpecifier(specifier)) {
      const resolved = resolveCandidateFile(specifier, baseDir);
      if (resolved !== undefined) {
        collectStaticDeps(resolved, visit, seen);
      }
    }
    match = STATIC_SPECIFIER.exec(text);
  }
}

function resolveFallbackCandidate(
  specifier: string,
  parentURL: string | undefined
): ResolveResult | undefined {
  if (
    !(parentURL?.startsWith("file:") && isRelativeOrFileSpecifier(specifier))
  ) {
    return undefined;
  }
  const candidate = resolveCandidateFile(
    specifier,
    dirname(fileURLToPath(parentURL))
  );
  return candidate === undefined
    ? undefined
    : { shortCircuit: true, url: pathToFileURL(candidate).href };
}

function attachSessionParam(
  specifier: string,
  result: ResolveResult,
  parentURL: string | undefined
): ResolveResult {
  if (
    parentURL === undefined ||
    !result.url.startsWith("file:") ||
    !isRelativeOrFileSpecifier(specifier)
  ) {
    return result;
  }
  const loadParam = new URL(parentURL).searchParams.get(LOAD_PARAM);
  if (loadParam === null) {
    return result;
  }
  const resolvedUrl = new URL(result.url);
  const filePath = realPathOf(fileURLToPath(resolvedUrl));
  if (!isInsideMarblesOrNodeModules(filePath)) {
    assertEsmWorkspaceFile(filePath);
  }
  const session = activeSessions.get(Number(loadParam));
  if (session !== undefined) {
    recordSessionFile(session, filePath);
  }
  if (
    !(
      isInsideMarblesOrNodeModules(filePath) ||
      resolvedUrl.searchParams.has(LOAD_PARAM)
    )
  ) {
    resolvedUrl.searchParams.set(LOAD_PARAM, loadParam);
    return { ...result, url: resolvedUrl.href };
  }
  return result;
}

function resolveNodeHook(
  specifier: string,
  context: ResolveContext,
  nextResolve: (specifier: string, context: ResolveContext) => ResolveResult
): ResolveResult {
  const selfTarget = SELF_URLS.get(specifier);
  if (selfTarget !== undefined) {
    return { shortCircuit: true, url: selfTarget };
  }
  let result: ResolveResult;
  try {
    result = nextResolve(specifier, context);
  } catch (error) {
    const fallback = resolveFallbackCandidate(specifier, context.parentURL);
    if (fallback === undefined) {
      throw error;
    }
    result = fallback;
  }
  return attachSessionParam(specifier, result, context.parentURL);
}

function loadNodeHook(
  url: string,
  context: LoadContext,
  nextLoad: (url: string, context: LoadContext) => LoadResult
): LoadResult {
  if (context.importAttributes?.type === "text" && url.startsWith("file:")) {
    const text = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  }
  const loaded = nextLoad(url, context);
  if (url.startsWith("file:")) {
    const parsed = new URL(url);
    if (parsed.searchParams.has(LOAD_PARAM) && loaded.format === "commonjs") {
      const filePath = realPathOf(fileURLToPath(parsed));
      if (!isInsideMarblesOrNodeModules(filePath)) {
        throw commonJsError(filePath);
      }
    }
  }
  return loaded;
}

function recordBunResolved(args: {
  readonly importer: string;
  readonly path: string;
}): undefined {
  if (!args.importer) {
    return;
  }
  const importerPath = realPathOf(
    args.importer.startsWith("file:")
      ? fileURLToPath(args.importer)
      : args.importer
  );
  if (isInsideMarblesOrNodeModules(importerPath)) {
    return;
  }
  const resolved = resolveCandidateFile(args.path, dirname(importerPath));
  if (resolved === undefined) {
    return;
  }
  assertEsmWorkspaceFile(resolved);
  for (const session of activeSessions.values()) {
    if (!session.disposed && session.files.has(importerPath)) {
      recordSessionFile(session, resolved);
    }
  }
}

export function detectLoaderAdapter(
  probe: LoaderRuntimeProbe = {
    bunPlugin: (globalThis as BunRuntimeGlobal).Bun?.plugin,
    registerHooks: (nodeModule as RegisterHooksApi).registerHooks,
  }
): "node" | "bun" {
  if (typeof probe.registerHooks === "function") {
    return "node";
  }
  if (typeof probe.bunPlugin === "function") {
    return "bun";
  }
  throw new UnsupportedLoaderRuntimeError(
    "Marbles requires Node.js >=22.18.0 (with module.registerHooks) or Bun >=1.3.14 to load workspace source modules."
  );
}

function ensureLoaderAdapter(): Promise<"node" | "bun"> {
  linkedAdapter ??= (async () => {
    const adapter = detectLoaderAdapter();
    if (adapter === "node") {
      const { registerHooks } = nodeModule as RegisterHooksApi;
      registerHooks?.({
        load: loadNodeHook,
        resolve: resolveNodeHook,
      });
      return "node";
    }
    const bunPlugin = (globalThis as BunRuntimeGlobal).Bun?.plugin;
    const eagerSelf = [
      "@foundry.sh/marbles",
      "@foundry.sh/marbles/prebuilt",
      "@foundry.sh/marbles/providers",
    ] as const;
    const loadedSelf = new Map<string, Record<string, unknown>>();
    for (const specifier of eagerSelf) {
      const url = SELF_URLS.get(specifier);
      if (url !== undefined) {
        loadedSelf.set(
          specifier,
          (await import(fileURLToPath(url))) as Record<string, unknown>
        );
      }
    }
    bunPlugin?.({
      name: "marbles-source-library",
      setup(builder) {
        for (const [specifier, mod] of loadedSelf) {
          builder.module(specifier, () => ({
            exports: mod,
            loader: "object",
          }));
        }
        for (const [specifier, url] of SELF_URLS) {
          if (loadedSelf.has(specifier)) {
            continue;
          }
          builder.module(specifier, async () => ({
            exports: (await import(fileURLToPath(url))) as Record<
              string,
              unknown
            >,
            loader: "object",
          }));
        }
        builder.onResolve(
          { filter: LOCAL_SPECIFIER_FILTER },
          recordBunResolved
        );
      },
      target: "bun",
    });
    return "bun";
  })();
  return linkedAdapter;
}

export async function openLoadSession(
  options: LoadSessionOptions = {}
): Promise<LoadSession> {
  const adapter = await ensureLoaderAdapter();
  sessionCounter += 1;
  const loadId = sessionCounter;
  const state: SessionState = {
    disposed: false,
    files: new Set<string>(),
    ...(options.read === undefined ? {} : { read: options.read }),
  };
  activeSessions.set(loadId, state);
  return {
    dispose(): void {
      state.disposed = true;
      activeSessions.delete(loadId);
    },
    files: state.files,
    async importModule(
      file: string
    ): Promise<Readonly<Record<string, unknown>>> {
      const execute = async (): Promise<Readonly<Record<string, unknown>>> => {
        const real = realPathOf(file);
        const deps: string[] = [];
        collectStaticDeps(real, (dep) => {
          recordSessionFile(state, dep);
          deps.push(dep);
        });
        const req = nodeModule.createRequire(import.meta.url);
        for (const dep of deps) {
          delete req.cache[dep];
        }
        const url = pathToFileURL(real);
        url.searchParams.set(LOAD_PARAM, String(loadId));
        return (await import(url.href)) as Readonly<Record<string, unknown>>;
      };
      return adapter === "bun"
        ? await withBunEvaluatingLoad(execute)
        : await execute();
    },
  };
}
