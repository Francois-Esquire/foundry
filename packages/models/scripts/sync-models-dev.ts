/**
 * Refresh the bundled models.dev snapshot.
 *
 *   bun run --cwd=packages/models sync:models-dev
 *
 * Deliberately manual. It is not in `turbo.json`, not a postinstall, and not a
 * CI gate — the app must never reach the network for model metadata (Airplane
 * Mode is a shipped feature, and tests have to be deterministic). This runs when
 * a human decides to refresh, and the resulting diff is reviewed like any other.
 *
 * That review is the point, so the output is pretty-printed and key-sorted: a
 * one-cent price change should render as one line, not "the whole file changed".
 *
 * Safety: every check runs before anything is written, and the write itself is
 * a tmp-file rename. A failed fetch, a truncated response, or an upstream schema
 * change leaves the committed snapshot exactly as it was.
 */

import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";

const SOURCE = "https://models.dev/catalog.json";
const OUT = new URL("../src/catalog/data/models-dev.json", import.meta.url)
  .pathname;

/** Upstream had ~293 models / ~180 providers when this was written. */
const MIN_MODELS = 200;
const MIN_PROVIDERS = 50;
/** A schema change that reintroduces bulk (benchmarks under a new key) aborts. */
const MAX_BYTES = 1_500_000;
/** A partial upstream outage that empties the map aborts. */
const MIN_RETAINED_RATIO = 0.8;

interface Snapshot {
  models: Record<string, PrunedModel>;
  source: string;
}

interface PrunedModel {
  attachment?: boolean;
  cost?: Record<string, unknown>;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
}

function fail(reason: string): never {
  console.error(`models.dev sync aborted — ${reason}`);
  console.error("The committed snapshot was left untouched.");
  process.exit(1);
}

const response = await fetch(SOURCE, {
  signal: AbortSignal.timeout(30_000),
}).catch((error: unknown) => fail(`fetch failed: ${String(error)}`));
if (!response.ok) {
  fail(`${SOURCE} returned ${String(response.status)}`);
}

const payload: unknown = await response
  .json()
  .catch((error: unknown) => fail(`response is not JSON: ${String(error)}`));

if (typeof payload !== "object" || payload === null) {
  fail("payload is not an object");
}
const { models, providers } = payload as {
  models?: Record<string, Record<string, unknown>>;
  providers?: Record<string, { models?: Record<string, { cost?: unknown }> }>;
};
if (!models || Array.isArray(models)) {
  fail("payload.models is not an object map");
}
if (!providers || Array.isArray(providers)) {
  fail("payload.providers is not an object map");
}
if (Object.keys(models).length < MIN_MODELS) {
  fail(
    `only ${String(Object.keys(models).length)} models (expected ≥ ${String(MIN_MODELS)})`
  );
}
if (Object.keys(providers).length < MIN_PROVIDERS) {
  fail(
    `only ${String(Object.keys(providers).length)} providers (expected ≥ ${String(MIN_PROVIDERS)})`
  );
}

/**
 * The vendor's own list price, or nothing.
 *
 * A price is only meaningful for a route, and most of models.dev's ~180
 * providers are aggregators re-listing the same model at their own markup —
 * taking one of those would be actively wrong. The first-party provider is the
 * one defensible universal number, and it is *derived*: an author whose id also
 * names a provider is that model's vendor. No hand-maintained map to rot.
 *
 * Open-weights models are skipped entirely: many hosts serve them at wildly
 * different prices, so there is no such thing as "the" price.
 */
function firstPartyCost(key: string, model: Record<string, unknown>): unknown {
  if (model.open_weights === true) {
    return undefined;
  }
  const [author, ...rest] = key.split("/");
  if (author === undefined || rest.length === 0) {
    return undefined;
  }
  // Provider maps are keyed by the bare model name, not the path-style id.
  return providers?.[author]?.models?.[rest.join("/")]?.cost;
}

/**
 * Keep only what a catalog row can actually consume. Whitelisted by explicit
 * key, never a denylist — an upstream field addition must be inert rather than
 * silently committed. `benchmarks` alone is most of the payload.
 */
function prune(key: string, model: Record<string, unknown>): PrunedModel {
  const limit = model.limit as
    | { context?: number; output?: number }
    | undefined;
  const modalities = model.modalities as
    | { input?: string[]; output?: string[] }
    | undefined;
  const cost = firstPartyCost(key, model);
  return {
    ...(typeof model.name === "string" ? { name: model.name } : {}),
    ...(model.attachment === true ? { attachment: true } : {}),
    ...(model.reasoning === true ? { reasoning: true } : {}),
    ...(model.tool_call === true ? { tool_call: true } : {}),
    ...(modalities?.input
      ? { modalities: { input: modalities.input, output: modalities.output } }
      : {}),
    ...(limit
      ? {
          limit: {
            ...(typeof limit.context === "number"
              ? { context: limit.context }
              : {}),
            ...(typeof limit.output === "number"
              ? { output: limit.output }
              : {}),
          },
        }
      : {}),
    ...(cost ? { cost: cost as Record<string, unknown> } : {}),
  };
}

const pruned: Record<string, PrunedModel> = {};
for (const key of Object.keys(models).sort()) {
  const model = models[key];
  if (model) {
    pruned[key] = prune(key, model);
  }
}

const snapshot: Snapshot = { models: pruned, source: SOURCE };
// Emit exactly what `format` would produce, so the generated file is a fixpoint
// rather than something the formatter rewrites on every refresh — otherwise the
// two fight and the diff this whole script exists to keep readable is noise.
const serialized = execFileSync("biome", ["format", "--stdin-file-path", OUT], {
  encoding: "utf8",
  input: JSON.stringify(snapshot),
});

if (serialized.length > MAX_BYTES) {
  fail(
    `output is ${String(Math.round(serialized.length / 1024))}KB, over the ${String(
      Math.round(MAX_BYTES / 1024)
    )}KB ceiling — did the prune list go stale?`
  );
}

// ---------------------------------------------------------------------------
// Diff against what is committed, so a reviewer sees what moved
// ---------------------------------------------------------------------------

const previousText = await readFile(OUT, "utf8").catch(() => null);
const previous = previousText
  ? (JSON.parse(previousText) as Snapshot).models
  : {};
const hadAny = Object.keys(previous).length > 0;

if (
  hadAny &&
  Object.keys(pruned).length < Object.keys(previous).length * MIN_RETAINED_RATIO
) {
  fail(
    `model count fell from ${String(Object.keys(previous).length)} to ${String(
      Object.keys(pruned).length
    )} — refusing to shrink the snapshot that far`
  );
}

if (previousText === serialized) {
  console.log(
    `models.dev sync — no changes (${String(Object.keys(pruned).length)} models)`
  );
  process.exit(0);
}

/** Flatten to leaf paths so a changed price is one line, not one object. */
function leaves(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    out.set(prefix, JSON.stringify(value));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    for (const [path, leaf] of leaves(v, prefix ? `${prefix}.${k}` : k)) {
      out.set(path, leaf);
    }
  }
  return out;
}

const added = Object.keys(pruned).filter((k) => !(k in previous));
const removed = Object.keys(previous).filter((k) => !(k in pruned));
const changed: string[] = [];
for (const key of Object.keys(pruned)) {
  const before = previous[key];
  if (!before) {
    continue;
  }
  const a = leaves(before);
  const b = leaves(pruned[key]);
  for (const [path, leaf] of b) {
    const was = a.get(path);
    if (was !== leaf) {
      changed.push(`${key}  ${path} ${was ?? "(added)"} → ${leaf}`);
    }
  }
  for (const [path] of a) {
    if (!b.has(path)) {
      changed.push(`${key}  ${path} (removed)`);
    }
  }
}

console.log(`models.dev sync — ${SOURCE}`);
console.log(
  `  snapshot   ${String(Object.keys(pruned).length)} models` +
    (hadAny ? ` (was ${String(Object.keys(previous).length)})` : "") +
    `   ${String(Math.round(serialized.length / 1024))}KB`
);
const report = (label: string, lines: string[]) => {
  if (lines.length === 0) {
    return;
  }
  console.log(`\n  ${label}  ${String(lines.length)}`);
  for (const line of lines.slice(0, 40)) {
    console.log(`    ${line}`);
  }
  if (lines.length > 40) {
    console.log(`    … and ${String(lines.length - 40)} more`);
  }
};
report("added", added);
report("removed", removed);
report("changed", changed);

const tmp = `${OUT}.tmp`;
await writeFile(tmp, serialized, "utf8");
await rename(tmp, OUT);
console.log(`\n  written    ${OUT}`);
