import type { ReactNode } from "react";
import { cn } from "~/app/lib/cn";
import type {
  AuditObservationStatus,
  AuditRun,
  AuditRunStatus,
} from "~/shared/audit";

/**
 * A read-only audit table: a caption naming it, column headers, and the
 * rows it is given. An empty table says so instead of showing headers alone.
 */
export function AuditTable({
  caption,
  children,
  count,
  empty,
  headers,
}: {
  caption: string;
  children: ReactNode;
  count: number;
  empty: string;
  headers: readonly string[];
}) {
  if (count === 0) {
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-border/60 border-b">
            {headers.map((header) => (
              <th
                className="whitespace-nowrap px-2 py-2 font-medium text-muted-foreground text-xs"
                key={header}
                scope="col"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** One table row; a highlighted row is the one a link pointed at. */
export function AuditRow({
  children,
  highlighted = false,
}: {
  children: ReactNode;
  highlighted?: boolean;
}) {
  return (
    <tr
      aria-current={highlighted ? "true" : undefined}
      className={cn(
        "border-border/30 border-b align-top [&>td]:px-2 [&>td]:py-2",
        highlighted && "bg-muted/50"
      )}
    >
      {children}
    </tr>
  );
}

const STATUS_LABELS: Readonly<
  Record<AuditRunStatus | AuditObservationStatus, string>
> = {
  cancelled: "Cancelled",
  complete: "Complete",
  denied: "Denied",
  failed: "Failed",
  interrupted: "Interrupted",
  queued: "Queued",
  running: "Running",
  suspended: "Waiting",
};

const STATUS_TONES: Readonly<Record<string, string>> = {
  denied: "text-destructive",
  failed: "text-destructive",
  interrupted: "text-destructive",
};

export function StatusText({
  status,
}: {
  status: AuditRunStatus | AuditObservationStatus;
}) {
  return (
    <span className={cn("whitespace-nowrap", STATUS_TONES[status])}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** A timestamp as local date and time, machine-readable underneath. */
export function Time({ value }: { value: string | undefined }) {
  if (value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <time className="whitespace-nowrap" dateTime={value}>
      {new Date(value).toLocaleString()}
    </time>
  );
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return "—";
  }
  return ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

type Progress = AuditRun["progress"];

function isRecord(
  progress: Progress
): progress is Exclude<Progress, readonly unknown[]> & object {
  return (
    typeof progress === "object" &&
    progress !== null &&
    !Array.isArray(progress)
  );
}

/** A run's latest progress, read from the shapes Works runs report. */
export function progressText(progress: Progress): string {
  if (progress === undefined || progress === null) {
    return "—";
  }
  if (isRecord(progress)) {
    const { count, phase, step, tick } = progress;
    if (typeof tick === "number" && typeof count === "number") {
      return `${String(tick)} of ${String(count)}`;
    }
    if (typeof phase === "string") {
      return phase;
    }
    if (typeof step === "string") {
      return step;
    }
  }
  return "Reported";
}

/** A settled run's error code and message, if it failed. */
export function Outcome({ run }: { run: AuditRun }) {
  if (!run.error) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <>
      <span className="font-mono text-xs">{run.error.code}</span>
      {run.error.message && (
        <span className="block text-muted-foreground text-xs">
          {run.error.message}
        </span>
      )}
    </>
  );
}
