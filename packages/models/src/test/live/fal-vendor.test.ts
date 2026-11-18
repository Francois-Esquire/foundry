import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { FAL_DEFAULT_MODELS } from "../../fal/catalog";
import { falCredentialAccess, falProvider } from "../../fal/provider";
import type { LiveAccess, LiveTarget } from "../../live/types";
import { operationsOf } from "../../provider";
import type { CapabilityFact, OperationName } from "../../types";

const { FAL_KEY } = process.env;

const KLEIN = "fal-ai/flux-2/klein/realtime";
const LUCY = "decart/lucy-2-5/realtime";
const H3 = "minimax/h3-max/director";

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
    const { open } = await import("../../live/node/index");
    const target = liveTarget(H3, "generate-video");

    const live = await open(target, falCredentialAccess(FAL_KEY ?? ""), {
      direction: { prompt: "a harbour at dawn" },
    });
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
    const [feed] = stream.getTracks();
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
