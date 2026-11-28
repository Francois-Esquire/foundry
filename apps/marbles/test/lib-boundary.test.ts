import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const LIB_ROOT = resolve(import.meta.dirname, "../src/lib");
const DIST_ROOT = resolve(import.meta.dirname, "../dist");
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../..");

const BARE_BUILTINS = new Set(
  builtinModules.map((name) => name.replace("node:", ""))
);

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

const NODE_SUBPATH_RE = /^@foundry\/[^/]+\/node(?:\/|$)/;
const NON_LIB_TILDE_RE = /^~\/(?!lib(?:\/|$))/;
const NODE_BUILTIN_RE =
  /^(?:node:|bun:|(?:assert|async_hooks|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)(?:\/|$))/;

const FORBIDDEN_GLOBAL_RE =
  /(?<![.\w$])(?:process|Buffer|Bun|__dirname|__filename|setImmediate|clearImmediate)\b(?!\s*:)/g;

const STRING_OR_COMMENT_RE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files.sort();
}

function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function isNodeOrBunBuiltin(specifier: string): boolean {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
    return true;
  }
  const root = specifier.split("/")[0] ?? "";
  return BARE_BUILTINS.has(specifier) || BARE_BUILTINS.has(root);
}

describe("src/lib runtime-agnostic boundary", () => {
  const libFiles = walkTsFiles(LIB_ROOT);

  it("contains no Node/Bun built-ins, @foundry/*/node imports, or imports outside src/lib", () => {
    expect(libFiles.length).toBeGreaterThan(0);
    const violations: string[] = [];

    for (const file of libFiles) {
      const rel = relative(LIB_ROOT, file);
      const source = readFileSync(file, "utf8");
      for (const specifier of extractSpecifiers(source)) {
        if (isNodeOrBunBuiltin(specifier)) {
          violations.push(`${rel} -> ${specifier} (Node/Bun built-in)`);
        } else if (NODE_SUBPATH_RE.test(specifier)) {
          violations.push(`${rel} -> ${specifier} (Node subpath)`);
        } else if (specifier.startsWith("@libsql/client")) {
          violations.push(`${rel} -> ${specifier} (libsql)`);
        } else if (NON_LIB_TILDE_RE.test(specifier)) {
          violations.push(`${rel} -> ${specifier} (outside src/lib)`);
        } else if (specifier.startsWith(".")) {
          const resolved = resolve(dirname(file), specifier);
          const insideLib =
            resolved === LIB_ROOT || resolved.startsWith(`${LIB_ROOT}${sep}`);
          if (!insideLib) {
            violations.push(`${rel} -> ${specifier} (escapes src/lib)`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("references no unguarded Node/Bun globals", () => {
    const violations: string[] = [];

    for (const file of libFiles) {
      const rel = relative(LIB_ROOT, file);
      const stripped = readFileSync(file, "utf8").replace(
        STRING_OR_COMMENT_RE,
        " "
      );
      for (const match of stripped.matchAll(FORBIDDEN_GLOBAL_RE)) {
        violations.push(`${rel}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it.each(["src/lib/index.ts", "src/lib/engine/index.ts"])(
    "bundles %s for browser target with zero Node/Bun built-ins",
    async (entry) => {
      const forbidden: string[] = [];
      const built = await globalThis.Bun.build({
        entrypoints: [resolve(import.meta.dirname, "..", entry)],
        plugins: [
          {
            name: "forbid-node-builtins",
            setup(build) {
              build.onResolve({ filter: NODE_BUILTIN_RE }, (args) => {
                forbidden.push(`${args.importer} -> ${args.path}`);
                return { external: true, path: args.path };
              });
            },
          },
        ],
        root: WORKSPACE_ROOT,
        target: "browser",
      });

      expect(forbidden).toEqual([]);
      expect(built.success).toBe(true);
    }
  );

  it("built dist/lib.js and its transitive chunks import no Node/Bun built-ins or node chunks", () => {
    const distLib = resolve(DIST_ROOT, "lib.js");
    expect(existsSync(distLib)).toBe(true);

    const visited = new Set<string>();
    const queue = [distLib];
    const violations: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const rel = relative(DIST_ROOT, current);
      const source = readFileSync(current, "utf8");
      for (const specifier of extractSpecifiers(source)) {
        if (isNodeOrBunBuiltin(specifier)) {
          violations.push(`${rel} -> ${specifier} (Node/Bun built-in)`);
        } else if (specifier.startsWith("./node-")) {
          violations.push(`${rel} -> ${specifier} (Node chunk)`);
        } else if (specifier.startsWith(".")) {
          const target = resolve(dirname(current), specifier);
          if (existsSync(target)) {
            queue.push(target);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
