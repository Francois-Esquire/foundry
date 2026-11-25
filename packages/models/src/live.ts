import type { HostAdapter } from "./live/core";
import { openCore } from "./live/core";
import { falTransports } from "./live/fal/transports";
import type { Sampler } from "./live/sampler";
import { sampleStream } from "./live/sampler";
import type {
  LiveAccess,
  LiveInteraction,
  LiveOptions,
  LiveTarget,
} from "./live/types";
import type { Media } from "./media";

export type {
  JsonValue,
  LiveAccess,
  LiveClosedReason,
  LiveDirection,
  LiveInteraction,
  LiveOptions,
  LiveResult,
  LiveState,
  LiveTarget,
} from "./live/types";

export interface BrowserLiveOptions extends LiveOptions {
  readonly feed?: MediaStream;
  readonly onStream?: (stream: MediaStream, direction: number) => void;
}

export interface BrowserLiveInteraction extends LiveInteraction {
  attach(feed: MediaStream): void;
}

const DEFAULT_SAMPLE_MS = 100;

export async function open(
  target: LiveTarget,
  access: LiveAccess,
  options: BrowserLiveOptions
): Promise<BrowserLiveInteraction> {
  const adapter: HostAdapter = {
    data: () => undefined,
    media: (media, direction) => {
      options.onStream?.(media as MediaStream, direction);
    },
  };
  const core = await openCore({
    access,
    adapter,
    connect: falTransports,
    options,
    target,
  });

  let sampler: Sampler | null = null;
  core.addTeardown(() => {
    sampler?.stop();
    sampler = null;
  });

  return {
    attach(feed) {
      if (core.state !== "open") {
        core.refuse("feed", "the interaction is no longer open");
        return;
      }
      if (target.fact.delivery === "continuous") {
        core.refuse(
          "feed",
          "a continuous session negotiates its feed at open; pass it as options.feed there"
        );
        return;
      }
      if (!target.fact.inputs.includes("feed")) {
        core.refuse("feed", "this Model does not accept a feed");
        return;
      }
      try {
        sampler?.stop();
        sampler = sampleStream(
          feed,
          options.throttleMs ?? DEFAULT_SAMPLE_MS,
          (frame) => {
            core.supply(frame);
          }
        );
      } catch (error) {
        core.refuse(
          "feed",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
    close: () => {
      core.close();
    },
    direct: (direction) => core.direct(direction),
    get direction() {
      return core.direction;
    },
    reference: (media: readonly Media[]) => {
      core.reference(media);
    },
    get state() {
      return core.state;
    },
    supply: (frame, id) => {
      core.supply(frame, id);
    },
  };
}
