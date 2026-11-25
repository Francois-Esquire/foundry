import { modelErrors } from "../../errors";
import type {
  Mask,
  Media,
  MediaInput,
  MediaModel,
  MediaOutput,
  SegmentationPrompt,
} from "../../media";
import type { FalRuntime } from "./client";

type Payload = Record<string, unknown>;

export function falMediaModel(
  endpointId: string,
  runtime: () => FalRuntime | null
): MediaModel {
  return {
    run: async (input, options) => {
      const configured = runtime();
      if (!configured) {
        throw modelErrors.PROVIDER_UNAVAILABLE({
          kind: input.operation,
          provider: "fal",
        });
      }
      return await run(configured, endpointId, input, options?.signal);
    },
  };
}

async function run(
  runtime: FalRuntime,
  endpointId: string,
  input: MediaInput,
  signal?: AbortSignal
): Promise<MediaOutput> {
  switch (input.operation) {
    case "segment-image": {
      const imageUrl = await upload(runtime, input.image);
      const data = await subscribe(runtime, endpointId, signal, {
        image_url: imageUrl,
        include_boxes: true,
        include_scores: true,
        output_format: "png",
        ...promptFields(input.prompt),
      });
      return {
        masks: await toMasks(runtime, data, input.prompt, signal),
        operation: "segment-image",
      };
    }
    case "segment-video": {
      const videoUrl = await upload(runtime, input.video);
      const data = await subscribe(runtime, endpointId, signal, {
        video_url: videoUrl,
        ...promptFields(input.prompt),
      });
      const video = asPayload(
        asPayload(data, "segment-video").video,
        "segment-video file"
      );
      return {
        operation: "segment-video",
        preview: await download(runtime, video, "video/mp4", signal),
        tracks: [],
      };
    }
    case "generate-music": {
      const data = await subscribe(runtime, endpointId, signal, {
        prompt: input.direction,
        ...(input.durationSeconds === undefined
          ? {}
          : { music_length_ms: Math.round(input.durationSeconds * 1000) }),
      });
      return {
        audio: await toAudio(runtime, data, signal),
        operation: "generate-music",
      };
    }
    case "generate-sound-effect": {
      const data = await subscribe(runtime, endpointId, signal, {
        text: input.direction,
        ...(input.durationSeconds === undefined
          ? {}
          : { duration_seconds: input.durationSeconds }),
      });
      return {
        audio: await toAudio(runtime, data, signal),
        operation: "generate-sound-effect",
      };
    }
    default:
      return unhandled(input);
  }
}

async function subscribe(
  runtime: FalRuntime,
  endpointId: string,
  signal: AbortSignal | undefined,
  body: Record<string, unknown>
): Promise<unknown> {
  const result = await runtime.client.subscribe(endpointId, {
    input: body,
    ...(signal ? { abortSignal: signal } : {}),
  });
  return result.data;
}

async function upload(runtime: FalRuntime, media: Media): Promise<string> {
  return runtime.client.storage.upload(
    new Blob([new Uint8Array(media.bytes)], { type: media.mime })
  );
}

function promptFields(prompt: SegmentationPrompt): Record<string, unknown> {
  switch (prompt.kind) {
    case "text":
      return { prompt: prompt.text };
    case "points":
      return {
        point_prompts: prompt.points.map((point) => ({
          label: point.label,
          x: point.x,
          y: point.y,
        })),
      };
    case "box":
      return {
        box_prompts: [
          {
            x_max: prompt.box.x + prompt.box.width,
            x_min: prompt.box.x,
            y_max: prompt.box.y + prompt.box.height,
            y_min: prompt.box.y,
          },
        ],
      };
    default:
      return unhandled(prompt);
  }
}

async function toMasks(
  runtime: FalRuntime,
  data: unknown,
  prompt: SegmentationPrompt,
  signal: AbortSignal | undefined
): Promise<Mask[]> {
  const response = asPayload(data, "segment-image");
  const files = asArray(response.masks, "segment-image").map((entry) =>
    asPayload(entry, "segment-image file")
  );
  const metadata = Array.isArray(response.metadata)
    ? response.metadata.map((entry) => asPayload(entry, "segment-image"))
    : [];
  const scores = numbers(response.scores);
  const boxes = Array.isArray(response.boxes) ? response.boxes : [];
  const images = await Promise.all(
    files.map((file) => download(runtime, file, "image/png", signal))
  );
  return images.map((image, index) => {
    const meta = metadata[index];
    const score = number(meta?.score) ?? scores[index];
    const box = toBox(meta?.box ?? boxes[index]);
    return {
      id: `mask-${String(number(meta?.index) ?? index)}`,
      ...(prompt.kind === "text" ? { label: prompt.text } : {}),
      ...(score === undefined ? {} : { score }),
      ...(box ? { box } : {}),
      image,
    };
  });
}

async function toAudio(
  runtime: FalRuntime,
  data: unknown,
  signal: AbortSignal | undefined
): Promise<Media> {
  const audio = asPayload(asPayload(data, "audio").audio, "audio file");
  return download(runtime, audio, "audio/mpeg", signal);
}

async function download(
  runtime: FalRuntime,
  file: Payload,
  fallbackMime: string,
  signal: AbortSignal | undefined
): Promise<Media> {
  const url = string(file.url);
  if (url === undefined) {
    throw malformed("a file without a url");
  }
  const response = await runtime.fetch(url, signal ? { signal } : {});
  if (!response.ok) {
    throw new Error(
      `[fal] could not read the result file: ${String(response.status)} ${response.statusText}`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes,
    mime:
      string(file.content_type) ??
      response.headers.get("content-type") ??
      fallbackMime,
  };
}

function toBox(
  value: unknown
): { x: number; y: number; width: number; height: number } | undefined {
  if (!Array.isArray(value) || value.length < 4) {
    return undefined;
  }
  const [cx, cy, width, height] = numbers(value);
  if (
    cx === undefined ||
    cy === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return undefined;
  }
  return { height, width, x: cx - width / 2, y: cy - height / 2 };
}

function isPayload(value: unknown): value is Payload {
  return typeof value === "object" && value !== null;
}

function asPayload(value: unknown, what: string): Payload {
  if (!isPayload(value)) {
    throw malformed(`a ${what} response that is not an object`);
  }
  return value;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw malformed(`a ${what} response without a list of masks`);
  }
  return value;
}

function numbers(value: unknown): (number | undefined)[] {
  return Array.isArray(value) ? value.map(number) : [];
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function unhandled(value: never): never {
  throw new Error(`[fal] unhandled media request: ${JSON.stringify(value)}`);
}

function malformed(what: string): Error {
  return new Error(`[fal] the endpoint returned ${what}`);
}
