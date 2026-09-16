import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";

import type { LocalProviderSurface } from "../surface";
import type { WorkerRequest, WorkerSideTransport } from "./protocol";

import { decodeAudio } from "./protocol";

/**
 * The worker side of the bridge: hosts a real {@link LocalProvider} in an
 * unbound Node process and answers protocol requests with its models. All the
 * AI SDK semantics (reasoning middleware, chat templates, tool wiring) come
 * from the real provider — this file only moves calls and stream parts across
 * the transport. Runs anywhere plain Node runs; no Electron imports.
 */
export function runLocalWorker(
  transport: WorkerSideTransport,
  provider: LocalProviderSurface
): void {
  // Per-request abort controllers so a host `cancel` reaches a live stream.
  const inFlight = new Map<number, AbortController>();

  for (const name of ["download-progress", "model-loaded"] as const) {
    provider.events.on(name, (payload: unknown) => {
      transport.send({ id: 0, name, payload, type: "event" });
    });
  }

  const fail = (id: number, error: unknown) => {
    transport.send({
      id,
      message: error instanceof Error ? error.message : String(error),
      type: "error",
      ...(error instanceof Error ? { name: error.name } : {}),
    });
  };

  transport.onMessage((req: WorkerRequest) => {
    if (req.op === "cancel") {
      inFlight.get(req.target)?.abort();
      return;
    }
    void handle(req).catch((error: unknown) => {
      fail(req.id, error);
    });
  });

  async function handle(req: Exclude<WorkerRequest, { op: "cancel" }>) {
    const done = (value: unknown) => {
      transport.send({ id: req.id, type: "result", value });
    };

    switch (req.op) {
      case "generate":
      case "stream": {
        const controller = new AbortController();
        inFlight.set(req.id, controller);
        try {
          const model = provider.languageModel(req.model);
          const options = {
            ...req.options,
            abortSignal: controller.signal,
          } as LanguageModelV4CallOptions;
          if (req.op === "generate") {
            // request/response carry HTTP debug info — meaningless on-device.
            const {
              request: _req,
              response: _res,
              ...result
            } = await model.doGenerate(options);
            done(result);
            return;
          }
          const { stream } = await model.doStream(options);
          const reader = stream.getReader();
          for (;;) {
            const { done: finished, value } = await reader.read();
            if (finished) {
              break;
            }
            transport.send({ id: req.id, part: value, type: "stream-part" });
          }
          transport.send({ id: req.id, type: "stream-end" });
        } finally {
          inFlight.delete(req.id);
        }
        return;
      }
      case "embed": {
        if (!provider.embeddingModel) {
          throw new Error("[remote-local] provider has no embedding model");
        }
        const { response: _res, ...result } = await provider
          .embeddingModel(req.model)
          .doEmbed(req.options);
        done(result);
        return;
      }
      case "transcribe": {
        done(
          await provider.transcribe(
            decodeAudio(req.audio),
            req.options,
            req.model
          )
        );
        return;
      }
      case "download": {
        await provider.download(req.model);
        done(null);
        return;
      }
      case "preload": {
        await provider.preload();
        done(null);
        return;
      }
      case "status": {
        done(provider.status());
        return;
      }
      case "progress": {
        done(provider.progress(req.model));
        return;
      }
      case "set-offline": {
        provider.setOffline?.(req.offline);
        done(null);
        return;
      }
    }
  }
}
