import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { DatasetAnalysis } from "../../lib/dataset-analysis";
import type {
  FileMapScanner,
  FileMapScanProgress,
} from "../../lib/file-map-scanner";
import type { RepositoryAcquisitionError } from "../../lib/github-loader";
import {
  parseGitHubRepositoryInput,
  RepositoryInputError,
} from "../../lib/github-request";
import type { SpyglassData } from "../data/types";
import {
  type LateReadings,
  loadHeldSpyglass,
  loadLateReadings,
} from "../layout/load-spyglass";
import { afterFirstFrame } from "../timings";
import Spyglass from "../ui/spyglass-view";
import { AnalysisSummary, gapLine } from "./analysis-summary";
import { loadAnalysis } from "./load-analysis";

import "../ui/spyglass.css";
import "./scan.css";

interface Fields {
  dir: string;
  ref: string;
  repo: string;
}

interface Result {
  analysis: DatasetAnalysis;
  data: SpyglassData;
  late: Promise<LateReadings>;
  timing: { acquireMs: number; analyzeMs: number };
}

type Status =
  | { kind: "idle"; notice?: string }
  | { kind: "running"; step: string }
  | { kind: "failed"; problems: readonly string[]; title: string }
  | { kind: "ready"; result: Result };

function fieldsFromQuery(search: string): Fields {
  const params = new URLSearchParams(search);
  return {
    dir: params.get("dir") ?? "",
    ref: params.get("ref") ?? "",
    repo: params.get("repo") ?? "",
  };
}

function rememberFields(fields: Fields): void {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value.trim() !== "") {
      params.set(key, value.trim());
    }
  }
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query === "" ? "" : `?${query}`}`
  );
}

const optional = (value: string) =>
  value.trim() === "" ? undefined : value.trim();

function stepLabel(progress: FileMapScanProgress): string {
  switch (progress.phase) {
    case "resolve":
      return "Resolving the commit on GitHub…";
    case "list":
      return "Listing the repository's files…";
    case "download":
      return `Downloading files from GitHub: ${progress.done} of ${progress.files}`;
    case "prepare":
      return "Preparing the TypeScript program and module graph…";
    case "analyze":
      return `Analysing ${progress.package} (${progress.index + 1} of ${progress.total})`;
    case "derive":
      return "Deriving the workspace's dependencies…";
    default:
      return `Assembling the dataset: ${progress.step}`;
  }
}

const isAbort = (error: unknown) =>
  error instanceof Error && error.name === "AbortError";

function describeFailure(error: unknown): {
  problems: string[];
  title: string;
} {
  if (error instanceof RepositoryInputError) {
    return {
      problems: [...error.problems],
      title: "That repository URL is not supported",
    };
  }
  if (error instanceof Error && error.name === "RepositoryAcquisitionError") {
    const { code, message } = error as RepositoryAcquisitionError;
    const titles: Partial<Record<RepositoryAcquisitionError["code"], string>> =
      {
        "limit-exceeded": "The repository is over this page's limits",
        network: "GitHub could not be reached",
        "not-found-or-private": "Repository not found",
        "private-repository": "The repository is private",
        "rate-limited": "GitHub's rate limit was reached",
        "ref-not-found": "Ref not found",
        "scope-not-found": "Directory not found",
        "truncated-listing": "The repository is too large to list",
      };
    return {
      problems: [message],
      title: titles[code] ?? "The repository could not be downloaded",
    };
  }
  return {
    problems: [error instanceof Error ? error.message : String(error)],
    title: "The repository could not be analysed",
  };
}

function ScanForm({
  fields,
  onCancel,
  onChange,
  onSubmit,
  problems,
}: {
  fields: Fields;
  onCancel?: () => void;
  onChange: (fields: Fields) => void;
  onSubmit: () => void;

  problems: readonly string[];
}) {
  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      onSubmit();
    },
    [onSubmit]
  );
  const change = useCallback(
    ({ currentTarget }: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...fields, [currentTarget.name]: currentTarget.value }),
    [fields, onChange]
  );
  const field = (name: keyof Fields) => ({
    name,
    onChange: change,
    value: fields[name],
  });
  return (
    <form className="spyglass-scan-form" onSubmit={submit}>
      <label>
        <span>Public GitHub repository</span>
        <input
          {...field("repo")}
          autoComplete="off"
          placeholder="https://github.com/owner/repository"
          required
          spellCheck={false}
          type="url"
        />
      </label>
      <div className="spyglass-scan-options">
        <label>
          <span>Branch, tag or commit (optional)</span>
          <input
            {...field("ref")}
            autoComplete="off"
            placeholder="default branch"
            spellCheck={false}
          />
        </label>
        <label>
          <span>Directory (optional)</span>
          <input
            {...field("dir")}
            autoComplete="off"
            placeholder="whole repository"
            spellCheck={false}
          />
        </label>
      </div>
      {problems.length > 0 ? (
        <div className="spyglass-scan-failure" role="alert">
          <p className="spyglass-scan-title">
            That repository URL is not supported
          </p>
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="spyglass-scan-actions">
        <button type="submit">Scan</button>
        {onCancel === undefined ? null : (
          <button onClick={onCancel} type="button">
            Keep this map
          </button>
        )}
      </div>
    </form>
  );
}

function ResultPanel({
  onNewScan,
  result,
}: {
  onNewScan: () => void;
  result: Result;
}) {
  const { analysis, timing } = result;
  const origin =
    analysis.origin.kind === "github-repository" ? analysis.origin : undefined;
  const title =
    origin === undefined
      ? analysis.origin.root
      : `${origin.repository.owner}/${origin.repository.repo}${origin.repository.scope === null ? "" : `/${origin.repository.scope}`}`;
  return (
    <aside aria-label="Browser scan" className="spyglass-scan-result">
      <p className="spyglass-chrome-eyebrow">Browser scan · partial analysis</p>
      <p className="spyglass-scan-title">
        {title}
        {origin === undefined ? null : (
          <code> @ {origin.repository.resolvedCommit.slice(0, 7)}</code>
        )}
      </p>
      <p className="spyglass-scan-gaps">{gapLine(analysis)}</p>
      <details>
        <summary>What this scan could and could not see</summary>
        <AnalysisSummary analysis={analysis} />
        <p className="spyglass-scan-timing">
          Downloaded in {(timing.acquireMs / 1000).toFixed(1)} s, analysed in{" "}
          {(timing.analyzeMs / 1000).toFixed(1)} s, in this page.
        </p>
      </details>
      <button onClick={onNewScan} type="button">
        New scan
      </button>
    </aside>
  );
}

export function ScanPage() {
  const [fields, setFields] = useState(() =>
    fieldsFromQuery(window.location.search)
  );
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [choosing, setChoosing] = useState(false);
  const [inputProblems, setInputProblems] = useState<readonly string[]>([]);
  const choose = useCallback(() => setChoosing(true), []);
  const keepMap = useCallback(() => {
    setChoosing(false);
    setInputProblems([]);
  }, []);
  const scanner = useRef<FileMapScanner | undefined>(undefined);

  const latest = useRef(0);

  useEffect(
    () => () => {
      latest.current += 1;
      scanner.current?.reset();
    },
    []
  );

  const start = useCallback(async () => {
    let input: { ref?: string; scope?: string; url: string };
    try {
      input = {
        url: fields.repo,
        ...(optional(fields.ref) !== undefined && {
          ref: optional(fields.ref),
        }),
        ...(optional(fields.dir) !== undefined && {
          scope: optional(fields.dir),
        }),
      };

      parseGitHubRepositoryInput(input);
    } catch (error) {
      setInputProblems(describeFailure(error).problems);
      setStatus((previous) =>
        previous.kind === "failed" ? { kind: "idle" } : previous
      );
      return;
    }

    latest.current += 1;
    const run = latest.current;
    const current = () => latest.current === run;
    setInputProblems([]);
    setChoosing(false);
    rememberFields(fields);

    scanner.current?.reset();
    setStatus({
      kind: "running",
      step: "Loading the analysis engine (about 14 MB, once per visit)…",
    });
    try {
      const engine = await loadAnalysis();
      if (!current()) {
        return;
      }
      scanner.current ??= engine.createFileMapScanner();
      const started = performance.now();
      const scan = await engine.scanGitHubRepository(
        scanner.current,
        { ...input, now: new Date() },
        {
          onProgress: (progress) => {
            if (current()) {
              setStatus({ kind: "running", step: stepLabel(progress) });
            }
          },
        }
      );
      if (!current()) {
        return;
      }
      setStatus({ kind: "running", step: "Laying out the map…" });
      const data = await loadHeldSpyglass(scan.dataset.transport);
      const analysis = await scan.dataset.reader().analysis();
      if (!current()) {
        return;
      }
      if (analysis === undefined) {
        throw new Error("The scanned dataset has no analysis metadata.");
      }

      const read = loadLateReadings(data);
      read.catch((error: unknown) => {
        if (current()) {
          setStatus({ kind: "failed", ...describeFailure(error) });
        }
      });
      const late = Promise.all([read, afterFirstFrame()]).then(
        ([readings]) => readings
      );

      setInputProblems([]);
      const { downloadMs, listMs, resolveMs } = scan.acquisitionTiming;
      const acquireMs = downloadMs + listMs + resolveMs;
      setStatus({
        kind: "ready",
        result: {
          analysis,
          data,
          late,
          timing: {
            acquireMs,
            analyzeMs: performance.now() - started - acquireMs,
          },
        },
      });
    } catch (error) {
      if (current() && !isAbort(error)) {
        setStatus({ kind: "failed", ...describeFailure(error) });
      }
    }
  }, [fields]);

  const cancel = useCallback(() => {
    latest.current += 1;
    scanner.current?.reset();
    setStatus({ kind: "idle", notice: "Scan cancelled. Nothing was kept." });
  }, []);

  const clear = useCallback(() => {
    latest.current += 1;
    scanner.current?.reset();
    setFields({ dir: "", ref: "", repo: "" });
    setInputProblems([]);
    rememberFields({ dir: "", ref: "", repo: "" });
    setStatus({ kind: "idle" });
  }, []);

  if (status.kind === "ready") {
    return (
      <>
        <Spyglass data={status.result.data} late={status.result.late} />
        <div className="spyglass-scan-overlay">
          {choosing ? (
            <section aria-label="New scan" className="spyglass-scan-result">
              <ScanForm
                fields={fields}
                onCancel={keepMap}
                onChange={setFields}
                onSubmit={start}
                problems={inputProblems}
              />
            </section>
          ) : (
            <ResultPanel onNewScan={choose} result={status.result} />
          )}
        </div>
      </>
    );
  }
  const running = status.kind === "running";
  return (
    <main className="spyglass-scan-page">
      <h1>Spyglass</h1>
      <p className="spyglass-scan-lede">
        Map a public TypeScript repository on GitHub. The files are downloaded
        from GitHub and analysed in this page; nothing is sent to a server, and
        nothing in the repository is run.
      </p>
      <ScanForm
        fields={fields}
        onChange={setFields}
        onSubmit={start}
        problems={inputProblems}
      />
      <div aria-live="polite" className="spyglass-scan-status" role="status">
        {status.kind === "idle" && status.notice ? (
          <p>{status.notice}</p>
        ) : null}
        {running ? (
          <>
            <p>{status.step}</p>
            <p className="spyglass-scan-note">
              Analysis runs in this page and can hold it for a few seconds at a
              time.
            </p>
            <button onClick={cancel} type="button">
              Cancel
            </button>
          </>
        ) : null}
        {status.kind === "failed" ? (
          <div className="spyglass-scan-failure" role="alert">
            <p className="spyglass-scan-title">{status.title}</p>
            <ul>
              {status.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
            <div className="spyglass-scan-actions">
              <button onClick={start} type="button">
                Try again
              </button>
              <button onClick={clear} type="button">
                Start over
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <p className="spyglass-scan-note">
        Without signing in, GitHub allows 60 API requests an hour from your
        network address; each scan uses 3, and file downloads use GitHub's raw
        file host. Limits: up to 5,000 analysis files, 50 MB in total, 1 MB a
        file.
      </p>
    </main>
  );
}
