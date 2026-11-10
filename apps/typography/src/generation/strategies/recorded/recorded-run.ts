/**
 * The recorded run strategy: replays saved model output without calling the
 * model. Everything it produces is marked as recorded and keeps the run id,
 * time, model and cost of the real call.
 */
import type {
  GenerationStrategy,
  RawOutput,
  StrategyOutput,
} from "../strategy";
import {
  outputLabel,
  type RecordedRun,
  RecordedRunError,
  recordedLayout,
  recordedMediaType,
  recordedRunId,
  recordedTargets,
} from "./manifest";

const textOf = (
  files: ReadonlyMap<string, Uint8Array>,
  name: string | undefined
): string | undefined => {
  const bytes = name === undefined ? undefined : files.get(name);
  return bytes && new TextDecoder().decode(bytes);
};

export const recordedRunStrategy = (run: RecordedRun): GenerationStrategy => {
  const { files, manifest, output } = run;
  const runId = recordedRunId(run);
  const made = output.synthetic
    ? "a synthetic sheet, made without a model"
    : output.model;
  return {
    availability: () => ({ available: true }),
    generate(request): Promise<StrategyOutput> {
      const bytes = files.get(output.file);
      if (!bytes) {
        throw new RecordedRunError(
          `The recorded run names ${output.file}, which is not among its files.`
        );
      }
      const drawn = recordedTargets(run, request.face);
      const layout = recordedLayout(run, drawn);
      const keys = new Set(drawn.map((target) => target.key));
      const raw: RawOutput =
        output.kind === "sheet-svg"
          ? { kind: "sheet-svg", layout, svg: new TextDecoder().decode(bytes) }
          : {
              image: { bytes, mediaType: recordedMediaType(output) },
              kind: "sheet-image",
              layout,
            };
      return Promise.resolve({
        createdAt: manifest.createdAt,
        producedBy: output.synthetic ? "synthetic-sheet" : output.strategy,
        raw,
        recorded: true,
        runId,
        sent: {
          parameters: output.parameters ?? {},
          prompt: output.prompt ?? textOf(files, output.promptFile) ?? "",
          referenceSheet: textOf(files, manifest.reference?.vector) ?? "",
        },
        unmade: request.targets
          .filter((target) => !keys.has(target.key))
          .map((target) => ({
            key: target.key,
            reason: "The recorded run did not draw this glyph.",
          })),
        usage: {
          costUsd: output.costUsd ?? undefined,
          latencyMs:
            output.latencySeconds === undefined
              ? undefined
              : Math.round(output.latencySeconds * 1000),
          model: output.synthetic ? undefined : output.model,
        },
      });
    },
    id: `recorded-run:${runId}`,
    kind: "recorded-run",
    name: `Recorded run ${manifest.id} (${outputLabel(output)}): ${made}`,
  };
};
