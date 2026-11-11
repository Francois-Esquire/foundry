import { describe, expect, it, vi } from "vitest";
import type { ProofFont } from "~/proof/proof-subject";
import {
  type BuiltWorkingFace,
  createWorkingBuilds,
} from "~/proof/working-builds";
import { emptyProject } from "~/typeface/project";

const built = (faceId: string): BuiltWorkingFace => ({
  font: { faceId, id: `font-of-${faceId}` } as ProofFont,
  project: emptyProject(),
});

/** A build that finishes only when the test says so. */
const pendingBuild = () => {
  let finish: (result: BuiltWorkingFace) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const build = vi.fn(
    () =>
      new Promise<BuiltWorkingFace>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      })
  );
  return {
    build,
    fail: (error: Error) => fail(error),
    finish: (result: BuiltWorkingFace) => finish(result),
  };
};

/** Lets the promises a build settled run their handlers. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the working builds of the Proof place", () => {
  it("is idle for a face nothing was asked of, and for no face at all", () => {
    const builds = createWorkingBuilds();
    expect(builds.of("a")).toEqual({ status: "idle" });
    expect(builds.of(undefined)).toEqual({ status: "idle" });
    expect(builds.of("a")).toBe(builds.of("b"));
  });

  it("keeps one face's late result out of another face's build", async () => {
    const builds = createWorkingBuilds();
    const first = pendingBuild();
    const second = pendingBuild();
    builds.start("a", first.build);
    builds.start("b", second.build);
    expect(builds.of("a").status).toBe("building");
    expect(builds.of("b").status).toBe("building");

    first.finish(built("a"));
    await settled();
    expect(builds.of("a")).toMatchObject({
      font: { faceId: "a" },
      status: "built",
    });
    // Face B's build is still running, and still says so.
    expect(builds.of("b")).toEqual({ status: "building" });

    second.finish(built("b"));
    await settled();
    expect(builds.of("b")).toMatchObject({
      font: { faceId: "b" },
      status: "built",
    });
  });

  it("does not start a second build of a face whose build is running", async () => {
    const builds = createWorkingBuilds();
    const running = pendingBuild();
    const again = pendingBuild();
    expect(builds.start("a", running.build)).toBe(true);
    expect(builds.start("a", again.build)).toBe(false);
    expect(again.build).not.toHaveBeenCalled();
    running.finish(built("a"));
    await settled();
    // Once it has finished, the face can be built again.
    expect(builds.start("a", again.build)).toBe(true);
    expect(again.build).toHaveBeenCalledOnce();
    expect(builds.of("a")).toEqual({ status: "building" });
  });

  it("says why a build failed, and lets it be started again", async () => {
    const builds = createWorkingBuilds();
    const failing = pendingBuild();
    builds.start("a", failing.build);
    failing.fail(new Error("The font engine stopped."));
    await settled();
    expect(builds.of("a")).toEqual({
      message: "The font engine stopped.",
      status: "failed",
    });
    expect(
      builds.start("a", () => {
        throw new Error("The face has left the project.");
      })
    ).toBe(true);
    await settled();
    expect(builds.of("a")).toEqual({
      message: "The face has left the project.",
      status: "failed",
    });
  });

  it("tells its listeners of every change, and returns the same answer between changes", async () => {
    const builds = createWorkingBuilds();
    const running = pendingBuild();
    const heard = vi.fn();
    const stop = builds.subscribe(heard);
    builds.start("a", running.build);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(builds.of("a")).toBe(builds.of("a"));
    running.finish(built("a"));
    await settled();
    expect(heard).toHaveBeenCalledTimes(2);
    expect(builds.of("a")).toBe(builds.of("a"));
    stop();
    builds.start("a", pendingBuild().build);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
