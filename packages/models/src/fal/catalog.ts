import type { ProviderModelDefinition } from "../types";

/**
 * Facts are read off the pinned client's endpoint contract
 * (`@fal-ai/client/endpoints`, `EndpointTypeMap`); nothing is inferred from Kind.
 * Two rules, and they do not always coincide:
 *
 * - `inputs` is what the endpoint's input type accepts. A form absent from that
 *   type is absent here unless the row names the transport contract that
 *   supplies it — which only Lucy's `feed` does.
 * - `required` is what the *Operation* needs to be the thing a caller asked for.
 *   That is the endpoint's non-optional fields, plus any field the endpoint
 *   makes optional by supplying a default that would silently answer a different
 *   question — a segmentation with no concept, or a generation with no
 *   Direction. Each such row says so on itself.
 *
 * `outputs[0]` is the declared output type's MIME at its documented default
 * format, except on the two `continuous` rows, whose declared output is WebRTC
 * signalling rather than media; theirs is the recorded segment's container and
 * is named on the row.
 */
export const FAL_DEFAULT_MODELS: ProviderModelDefinition[] = [
  {
    id: "fal-ai/flux/dev",
    kind: "image",
    label: "FLUX.1 [dev]",
    modelId: "fal-ai/flux/dev",
    operations: [
      {
        delivery: "whole",
        inputs: ["direction"],
        mode: "request",
        operation: "generate-image",
        outputs: ["image/jpeg"],
        required: ["direction"],
      },
    ],
    vendor: "Black Forest Labs",
  },
  {
    id: "fal-ai/flux-2/klein/realtime",
    kind: "image",
    label: "FLUX.2 [klein] realtime",
    modelId: "fal-ai/flux-2/klein/realtime",
    operations: [
      {
        delivery: "result-per-input",
        inputs: ["direction", "frame"],
        mode: "live",
        operation: "generate-image",
        outputs: ["image/jpeg"],
        required: ["frame"],
      },
    ],
    vendor: "Black Forest Labs",
  },
  {
    id: "fal-ai/fast-lcm-diffusion/image-to-image",
    kind: "image",
    label: "Fast LCM image-to-image",
    modelId: "fal-ai/fast-lcm-diffusion/image-to-image",
    operations: [
      {
        delivery: "result-per-input",
        inputs: ["direction", "frame"],
        mode: "live",
        operation: "generate-image",
        outputs: ["image/jpeg"],
        required: ["direction", "frame"],
      },
    ],
  },
  {
    // Text-to-video only: `MinimaxVideo01Input` is `{ prompt, prompt_optimizer }`
    // with no image field. The image form belongs to the separate
    // `fal-ai/minimax/video-01/image-to-video` endpoint, which is not this row.
    id: "fal-ai/minimax/video-01",
    kind: "video",
    label: "MiniMax Video 01",
    modelId: "fal-ai/minimax/video-01",
    operations: [
      {
        delivery: "whole",
        inputs: ["direction"],
        mode: "request",
        operation: "generate-video",
        outputs: ["video/mp4"],
        required: ["direction"],
      },
    ],
    vendor: "MiniMax",
  },
  {
    // `Lucy25RealtimeInput` declares every field optional and its output is the
    // WebRTC signalling exchange (`sdp`, `candidate`, `iceServers`), not media.
    // So two things here are the Operation's rather than the endpoint's:
    // `direction` is required because a prompt-driven transform with no prompt
    // is not this Operation, and `video/webm` is the container the session's
    // recorded segment lands in. `feed` is the model's own — its page and the
    // `lucy` extension both take an incoming stream.
    id: "decart/lucy-2-5/realtime",
    kind: "video",
    label: "Lucy 2.5 realtime",
    modelId: "decart/lucy-2-5/realtime",
    operations: [
      {
        delivery: "continuous",
        inputs: ["direction", "feed"],
        mode: "live",
        operation: "generate-video",
        outputs: ["video/webm"],
        required: ["direction", "feed"],
      },
    ],
    vendor: "Decart",
  },
  {
    // The one row whose endpoint the pinned client's `EndpointTypeMap` does not
    // list. Its read contract is the model's own API page plus the `wma`
    // extension, which by its own documentation takes the endpoint it opens
    // rather than a set it claims — so absence from the map is not evidence
    // against the fact. `feed` is deliberately not an input: a local stream is
    // a transport capability of `wma`, not something this model is documented
    // to accept. `video/webm` is the recorded segment's container, as on Lucy.
    id: "minimax/h3-max/director",
    kind: "video",
    label: "MiniMax H3 Max Director",
    modelId: "minimax/h3-max/director",
    operations: [
      {
        delivery: "continuous",
        inputs: ["direction"],
        mode: "live",
        operation: "generate-video",
        outputs: ["video/webm"],
        required: ["direction"],
      },
    ],
    vendor: "MiniMax",
  },
  {
    id: "fal-ai/minimax/speech-02-hd",
    kind: "speech",
    label: "MiniMax Speech 02 HD",
    modelId: "fal-ai/minimax/speech-02-hd",
    operations: [
      {
        delivery: "whole",
        inputs: ["source-text"],
        mode: "request",
        operation: "generate-speech",
        outputs: ["audio/mpeg"],
        required: ["source-text"],
      },
    ],
    vendor: "MiniMax",
  },
  {
    // `wizperInput.audio_url` documents mp4 and webm among its supported
    // formats, which is what puts `source-video` in `inputs`. `required` names
    // the audio form because it cannot express "one of"; the vendor instrument
    // is what proves the video case.
    id: "fal-ai/wizper",
    kind: "transcription",
    label: "Wizper (Whisper v3)",
    modelId: "wizper",
    operations: [
      {
        delivery: "whole",
        inputs: ["source-audio", "source-video"],
        mode: "request",
        operation: "transcribe",
        outputs: ["text/plain"],
        required: ["source-audio"],
      },
    ],
  },
  {
    // `Sam3ImageInput` requires only `image_url`; its `prompt` is optional with
    // a stock default ("wheel"). Requiring the prompt here is the Operation's
    // doing: a segmentation the caller did not name is not Segment image.
    id: "fal-ai/sam-3/image",
    kind: "segmentation",
    label: "SAM 3 image",
    modelId: "fal-ai/sam-3/image",
    operations: [
      {
        delivery: "whole",
        inputs: ["source-image", "segmentation-prompt"],
        mode: "request",
        operation: "segment-image",
        outputs: ["application/json"],
        required: ["source-image", "segmentation-prompt"],
      },
    ],
    vendor: "Meta",
  },
  {
    // `Sam31VideoInput` requires only `video_url`; the prompt is required here
    // for the same reason as on the SAM 3 image row above.
    id: "fal-ai/sam-3-1/video",
    kind: "segmentation",
    label: "SAM 3.1 video",
    modelId: "fal-ai/sam-3-1/video",
    operations: [
      {
        delivery: "whole",
        inputs: ["source-video", "segmentation-prompt"],
        mode: "request",
        operation: "segment-video",
        outputs: ["application/json"],
        required: ["source-video", "segmentation-prompt"],
      },
    ],
    vendor: "Meta",
  },
  {
    // `ElevenlabsMusicInput` declares every field optional, including `prompt`:
    // the endpoint also accepts a `composition_plan` instead. This Operation
    // offers only the prompt form, so `direction` is required here. The limit
    // is the endpoint's own — `music_length_ms` is documented 3000–600000.
    id: "fal-ai/elevenlabs/music",
    kind: "music",
    label: "ElevenLabs Music",
    limits: { maxDurationSeconds: 600 },
    modelId: "fal-ai/elevenlabs/music",
    operations: [
      {
        delivery: "whole",
        inputs: ["direction"],
        mode: "request",
        operation: "generate-music",
        outputs: ["audio/mpeg"],
        required: ["direction"],
      },
    ],
    vendor: "ElevenLabs",
  },
  {
    id: "fal-ai/elevenlabs/sound-effects/v2",
    kind: "sound",
    label: "ElevenLabs Sound Effects v2",
    limits: { maxDurationSeconds: 22 },
    modelId: "fal-ai/elevenlabs/sound-effects/v2",
    operations: [
      {
        delivery: "whole",
        inputs: ["direction"],
        mode: "request",
        operation: "generate-sound-effect",
        outputs: ["audio/mpeg"],
        required: ["direction"],
      },
    ],
    vendor: "ElevenLabs",
  },
];
