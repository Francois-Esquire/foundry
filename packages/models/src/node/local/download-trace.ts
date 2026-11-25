import { createLogger } from "evlog";
import {
  isModelObservabilityEnabled,
  modelAudit,
  SYSTEM_ACTOR,
} from "../../observability";

export interface ModelDownloadTarget {
  dtype?: string;
  kind: string;
  label?: string;
  modelId: string;
}

interface DownloadTick {
  file?: string;
  loaded?: number;
  progress?: number;
  status: string;
  total?: number;
}

export interface ModelDownloadTrace {
  finish: (status: string) => void;
  track: (tick: DownloadTick) => void;
}

interface TraceFile {
  complete: boolean;
  loaded: number;
  total: number;
}

interface DownloadEventFields {
  download: Record<string, unknown>;
  task: string;
}

class DownloadTraceImpl implements ModelDownloadTrace {
  private readonly files = new Map<string, TraceFile>();
  private readonly target: ModelDownloadTarget;
  private log: ReturnType<typeof createLogger<DownloadEventFields>> | null =
    null;
  private startedAt: number | null = null;
  private ended = false as boolean;

  constructor(target: ModelDownloadTarget) {
    this.target = target;
  }

  track(tick: DownloadTick): void {
    if (
      this.log === null &&
      tick.status === "progress" &&
      typeof tick.progress === "number" &&
      tick.progress < 100
    ) {
      this.startedAt = Date.now();
      this.log = createLogger<DownloadEventFields>({
        download: this.identity(),
        task: "models.download",
      });
    }
    if (!tick.file) {
      return;
    }
    const prev = this.files.get(tick.file);
    const complete =
      prev?.complete === true ||
      tick.status === "done" ||
      (typeof tick.progress === "number" && tick.progress >= 100);
    this.files.set(tick.file, {
      complete,
      loaded: tick.loaded ?? prev?.loaded ?? 0,
      total: tick.total ?? prev?.total ?? 0,
    });
    if (complete && prev?.complete !== true) {
      this.log?.set({ download: this.summary() });
    }
  }

  finish(status: string): void {
    if (this.ended || this.log === null) {
      return;
    }
    if (status !== "ready") {
      for (const f of this.files.values()) {
        if (!f.complete) {
          return;
        }
      }
    }
    this.ended = true;
    this.log.set({ download: { ...this.identity(), ...this.summary() } });
    this.log.audit(
      modelAudit.MODEL_DOWNLOAD({
        actor: SYSTEM_ACTOR,
        target: { id: this.target.modelId },
      })
    );
    this.log.emit();
  }

  private identity(): Record<string, unknown> {
    return {
      modelId: this.target.modelId,
      ...(this.target.label ? { label: this.target.label } : {}),
      kind: this.target.kind,
      ...(this.target.dtype ? { dtype: this.target.dtype } : {}),
    };
  }

  private summary(): Record<string, unknown> {
    let totalBytes = 0;
    const files: { file: string; bytes: number }[] = [];
    for (const [file, f] of this.files) {
      const bytes = f.total > 0 ? f.total : f.loaded;
      totalBytes += bytes;
      files.push({ bytes, file });
    }
    return {
      fileCount: files.length,
      files,
      totalBytes,
      ...(this.startedAt === null
        ? {}
        : { durationMs: Date.now() - this.startedAt }),
    };
  }
}

const NOOP_DOWNLOAD_TRACE: ModelDownloadTrace = {
  finish: () => undefined,
  track: () => undefined,
};

export function traceModelDownload(
  target: ModelDownloadTarget
): ModelDownloadTrace {
  if (!isModelObservabilityEnabled()) {
    return NOOP_DOWNLOAD_TRACE;
  }
  return new DownloadTraceImpl(target);
}
