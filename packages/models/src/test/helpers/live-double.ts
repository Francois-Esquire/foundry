import type {
  Connect,
  TransportHandlers,
  TransportOptions,
  TransportSend,
} from "../../live/transport";
import type { LiveTarget } from "../../live/types";
import type { CapabilityFact, Media } from "../../types";

/** One connected transport double, driven by the test. */
export interface Double {
  readonly closed: () => boolean;
  deliver(correlation: string | undefined, media?: Media): void;
  drop(message?: string): void;
  emitData(raw: string): void;
  emitMedia(media: unknown): void;
  /** Hold every later `send` until `release` is called. */
  gate(): void;
  readonly handlers: TransportHandlers;
  readonly options: TransportOptions;
  release(): void;
  readonly sent: TransportSend[];
}

export interface Registry {
  connects: number;
  doubles: Double[];
  /** Set to reject the connect itself, or to fail the opening send. */
  failConnect: boolean;
  failPrime: boolean;
}

export function newRegistry(): Registry {
  return { connects: 0, doubles: [], failConnect: false, failPrime: false };
}

export function connector(registry: Registry): Connect {
  return (_target, _access, options, handlers) => {
    registry.connects += 1;
    if (registry.failConnect) {
      return Promise.reject(new Error("[double] connect refused"));
    }
    let gated = false;
    let closed = false;
    let primed = false;
    const waiting: (() => void)[] = [];
    const sent: TransportSend[] = [];
    const double: Double = {
      closed: () => closed,
      deliver(correlation, media) {
        handlers.message({
          media: media ?? { bytes: new Uint8Array([9]), mime: "image/jpeg" },
          ...(correlation === undefined ? {} : { correlation }),
        });
      },
      drop(message) {
        handlers.close("disconnected", message);
      },
      emitData(raw) {
        handlers.data(raw);
      },
      emitMedia(media) {
        handlers.media(media);
      },
      gate() {
        gated = true;
      },
      handlers,
      options,
      release() {
        for (const resume of waiting.splice(0)) {
          resume();
        }
      },
      sent,
    };
    registry.doubles.push(double);
    return Promise.resolve({
      close() {
        closed = true;
      },
      send(message: TransportSend) {
        if (!primed) {
          primed = true;
          if (registry.failPrime) {
            return Promise.reject(new Error("[double] opening send refused"));
          }
        }
        sent.push(message);
        if (!gated) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => waiting.push(resolve));
      },
    });
  };
}

export function fact(over: Partial<CapabilityFact> = {}): CapabilityFact {
  return {
    delivery: "result-per-input",
    inputs: ["direction", "frame"],
    mode: "live",
    operation: "generate-image",
    outputs: ["image/jpeg"],
    required: ["frame"],
    ...over,
  };
}

export function target(over: Partial<CapabilityFact> = {}): LiveTarget {
  const declared = fact(over);
  return {
    fact: declared,
    modelId: "vendor/model",
    operation: declared.operation,
    provider: "fal",
  };
}

export function frame(tag: number): Media {
  return { bytes: new Uint8Array([tag]), mime: "image/jpeg" };
}

export function token(): { kind: "token"; token: string; expiresAt: number } {
  return { expiresAt: Date.now() + 60_000, kind: "token", token: "t-1" };
}
