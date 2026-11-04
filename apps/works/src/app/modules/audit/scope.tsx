import { useQuery } from "@tanstack/react-query";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router";
import { worksApi } from "~/app/api/client";
import { type AuditGap, gapModule } from "~/shared/audit";
import { Time } from "./audit-table";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How often a time range's start moves on while the view stays open. */
const CLOCK_MS = 60_000;
const RANGES = [
  { days: 1, id: "1d", label: "Last 24 hours" },
  { days: 7, id: "7d", label: "Last 7 days" },
  { days: 30, id: "30d", label: "Last 30 days" },
  { days: null, id: "all", label: "All retained history" },
] as const;
type Range = (typeof RANGES)[number];

/** Module names and Artifact names, joined to runs by ID only. */
export interface Names {
  artifact(id: string): string;
  module(id: string | undefined): string;
}

export function useNames(): Names {
  const api = worksApi();
  const modules = useQuery(api.modules.list.queryOptions());
  const artifacts = useQuery(api.artifacts.list.queryOptions());
  return useMemo(() => {
    const moduleNames = new Map(
      (modules.data ?? []).map((module) => [module.id, module.name])
    );
    const artifactNames = new Map<string, string>([
      ...(modules.data ?? []).map(
        (module) => [module.artifactId, module.name] as const
      ),
      ...(artifacts.data ?? []).map(
        (artifact) => [artifact.id, artifact.name] as const
      ),
    ]);
    return {
      artifact: (id) => artifactNames.get(id) ?? `Artifact ${id.slice(0, 8)}`,
      module: (id) =>
        id === undefined
          ? "Works"
          : (moduleNames.get(id) ?? `Removed module ${id.slice(0, 8)}`),
    };
  }, [modules.data, artifacts.data]);
}

/** The time now, moving on every `CLOCK_MS` while `ticking`. */
function useClock(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/**
 * The audit scope and filters, kept in the page's search parameters. A
 * time range's start follows the clock, so "Last 24 hours" keeps sliding.
 */
export function useAuditParams() {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === null) {
            next.delete(key);
          } else {
            next.set(key, value);
          }
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );
  const range: Range =
    RANGES.find((item) => item.id === params.get("range")) ?? RANGES[3];
  const now = useClock(range.days !== null);
  const since = range.days === null ? undefined : now - range.days * DAY_MS;
  return {
    attempts: params.get("attempts") === "1",
    highlighted: params.get("run"),
    moduleId: params.get("module") ?? undefined,
    range: range.id,
    set,
    since,
  };
}

const SELECT_CLASS =
  "h-9 rounded-md border border-border bg-background px-2 text-sm";

export function ScopeControls({
  moduleId,
  moduleIds,
  names,
  onModule,
  onRange,
  range,
}: {
  moduleId: string | undefined;
  moduleIds: readonly string[];
  names: Names;
  onModule: (event: ChangeEvent<HTMLSelectElement>) => void;
  onRange: (event: ChangeEvent<HTMLSelectElement>) => void;
  range: Range["id"];
}) {
  const options = [...new Set([...moduleIds, ...(moduleId ? [moduleId] : [])])]
    .map((id) => ({ id, name: names.module(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label
          className="mb-1 block text-muted-foreground text-xs"
          htmlFor="audit-module"
        >
          Module
        </label>
        <select
          className={SELECT_CLASS}
          id="audit-module"
          onChange={onModule}
          value={moduleId ?? ""}
        >
          <option value="">All modules and Works</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label
          className="mb-1 block text-muted-foreground text-xs"
          htmlFor="audit-range"
        >
          Time range
        </label>
        <select
          className={SELECT_CLASS}
          id="audit-range"
          onChange={onRange}
          value={range}
        >
          {RANGES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Retention gaps are shown, never hidden: older history may be missing. */
export function RetentionNotice({
  gaps,
  names,
}: {
  gaps: readonly AuditGap[];
  names: Names;
}) {
  if (gaps.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Retention"
      className="rounded-lg border border-border/60 p-3 text-sm"
    >
      <p className="font-medium">Older history was removed by retention</p>
      <ul className="mt-1 text-muted-foreground">
        {gaps.map((gap) => (
          <li key={gap.scope}>
            {names.module(gapModule(gap) ?? undefined)}: {gap.removed}{" "}
            {gap.removed === 1 ? "run" : "runs"} that ended up to{" "}
            <Time value={gap.through} />. Later activity is complete.
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ModuleLink({
  id,
  names,
}: {
  id: string | undefined;
  names: Names;
}) {
  if (id === undefined) {
    return <span className="text-muted-foreground">Works</span>;
  }
  return (
    <Link
      className="underline-offset-2 hover:underline"
      to={`/modules/${encodeURIComponent(id)}`}
    >
      {names.module(id)}
    </Link>
  );
}

/** Enough of a run id to tell runs apart, whatever the engine prefixes it with. */
const SHORT_RUN_ID = 8;

export function RunLink({ id }: { id: string }) {
  return (
    <Link
      aria-label={`Run ${id}`}
      className="font-mono text-xs underline-offset-2 hover:underline"
      to={`/modules?tab=executions&run=${encodeURIComponent(id)}`}
    >
      {id.slice(-SHORT_RUN_ID)}
    </Link>
  );
}
