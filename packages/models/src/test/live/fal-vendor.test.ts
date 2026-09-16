/**
 * Caller-owned instrument for the Live vendor obligations, not a gate. Nothing
 * here runs without a key, and its absence of a run is the deferral.
 *
 *   FAL_KEY=… bun run --cwd=packages/models test -- live/fal-vendor
 *
 * Each test names the specification.md "Evidence limits" row it would close:
 * token acceptance on `realtime.connect` and `realtime.open`, Node WebRTC
 * negotiation against the vendor endpoints including Lucy 2.5's ordering, and
 * whether the recorder muxes the negotiated codec into a playable segment.
 *
 * The Lucy test needs a local track the repository does not carry. It is built
 * from werift's dummy media device, so no file is required — but a run that
 * cannot acquire one skips rather than failing.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { FAL_DEFAULT_MODELS } from "../../fal/catalog";
import { falProvider } from "../../fal/provider";
import type { LiveAccess, LiveTarget } from "../../live/types";
import { operationsOf } from "../../provider";
import type { CapabilityFact, OperationName } from "../../types";

// eslint-disable-next-line turbo/no-undeclared-env-vars
const FAL_KEY = process.env.FAL_KEY;

const KLEIN = "fal-ai/flux-2/klein/realtime";
const LUCY = "decart/lucy-2-5/realtime";
const H3 = "minimax/h3-max/director";

/** Constructing with a key is what writes the configured-client holder. */
function provider() {
  return falProvider({ config: { apiKey: FAL_KEY ?? "" } });
}

function grantOf(
  fal: ReturnType<typeof provider>,
  target: LiveTarget
): Promise<LiveAccess> {
  if (fal.grant === undefined) {
    throw new Error("the FAL provider declares no grant");
  }
  return fal.grant(target.modelId, target.operation);
}

function liveTarget(modelId: string, operation: OperationName): LiveTarget {
  const row = FAL_DEFAULT_MODELS.find((model) => model.id === modelId);
  if (row === undefined) {
    throw new Error(`no catalog row for ${modelId}`);
  }
  const fact: CapabilityFact | undefined = operationsOf(row).find(
    (candidate) =>
      candidate.mode === "live" && candidate.operation === operation
  );
  if (fact === undefined) {
    throw new Error(`no live fact for ${modelId}`);
  }
  return { fact, modelId: row.modelId, operation, provider: "fal" };
}

describe.skipIf(!FAL_KEY)("FAL live vendor obligations", () => {
  it("accepts a Provider-minted token on realtime.connect (Klein)", async () => {
    const fal = provider();
    const { open } = await import("../../live/index");
    const target = liveTarget(KLEIN, "generate-image");
    const access = await grantOf(fal, target);

    const results: number[] = [];
    const live = await open(target, access, {
      direction: { prompt: "a watercolour harbour" },
      onResult: (result) => results.push(result.direction),
    });
    live.supply({ bytes: new Uint8Array([0]), mime: "image/jpeg" }, "a");
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    live.close();
    expect(results.length).toBeGreaterThan(0);
  }, 60_000);

  it("negotiates a continuous session and records a segment (H3 Max Director)", async () => {
    provider();
    const { open } = await import("../../live/node/index");
    const target = liveTarget(H3, "generate-video");

    const live = await open(
      target,
      { kind: "credential" },
      {
        direction: { prompt: "a harbour at dawn" },
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    expect(live.tracks.length).toBeGreaterThan(0);

    const recording = live.record(join(tmpdir(), "foundry-live-h3.webm"));
    live.direct({ prompt: "now pan left" });
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const segment = await recording.stop();
    live.close();

    expect(segment.mime).toBe("video/webm");
    expect(segment.startedDirection).toBe(1);
    expect(segment.endedDirection).toBe(2);
  }, 120_000);

  it("negotiates a continuous session with a feed in the offer (Lucy 2.5)", async () => {
    const fal = provider();
    const { open, installWebRtc } = await import("../../live/node/index");
    installWebRtc();
    const { MediaDevices } = await import("werift/nonstandard");
    const devices = new MediaDevices({ dummyMedia: { enabled: true } });
    const stream = await devices.getUserMedia({ video: true });
    const feed = stream.getTracks()[0];
    if (feed === undefined) {
      return;
    }

    const target = liveTarget(LUCY, "generate-video");
    const access = await grantOf(fal, target);
    const live = await open(target, access, {
      direction: { prompt: "make it a cartoon" },
      feed,
    });
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    live.close();
    expect(live.tracks.length).toBeGreaterThan(0);
  }, 120_000);
});
