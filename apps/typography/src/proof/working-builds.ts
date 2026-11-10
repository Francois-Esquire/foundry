/**
 * The working builds of the Proof place: one for each face, built on demand.
 * A build takes a while, and a person can look at another face while it
 * runs, so each face has a slot of its own and every request is numbered. A
 * result goes into its face's slot only while it answers that slot's latest
 * request, and a face whose build is running does not start another.
 */
import type { FaceId } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import type { Workspace } from "~/workspace/workspace";
import type { ProofFont } from "./proof-subject";

/** A working face as built, with what it was built from. */
export interface BuiltWorkingFace {
  readonly font: ProofFont;
  /** The project the font was built from, so a later change can be seen. */
  readonly project: TypefaceProject;
}

export type WorkingBuild =
  | { readonly status: "idle" }
  | { readonly status: "building" }
  | ({ readonly status: "built" } & BuiltWorkingFace)
  | { readonly status: "failed"; readonly message: string };

export interface WorkingBuilds {
  /** Where a face's build stands. Idle before one was asked for. */
  of(faceId: FaceId | undefined): WorkingBuild;
  /**
   * Starts building a face and returns true. While that face's build is
   * running it starts nothing and returns false.
   */
  start(faceId: FaceId, build: () => Promise<BuiltWorkingFace>): boolean;
  /** Returns a function that stops the listener. */
  subscribe(listener: () => void): () => void;
}

interface Slot {
  readonly build: WorkingBuild;
  /** The number of the request this slot is waiting on or was settled by. */
  readonly request: number;
}

const IDLE: WorkingBuild = { status: "idle" };

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const createWorkingBuilds = (): WorkingBuilds => {
  const slots = new Map<FaceId, Slot>();
  const listeners = new Set<() => void>();
  let issued = 0;

  const put = (faceId: FaceId, slot: Slot) => {
    slots.set(faceId, slot);
    for (const listener of [...listeners]) {
      listener();
    }
  };

  return {
    of: (faceId) =>
      (faceId === undefined ? undefined : slots.get(faceId)?.build) ?? IDLE,
    start(faceId, build) {
      if (slots.get(faceId)?.build.status === "building") {
        return false;
      }
      issued += 1;
      const request = issued;
      put(faceId, { build: { status: "building" }, request });
      const settle = (settled: WorkingBuild) => {
        if (slots.get(faceId)?.request === request) {
          put(faceId, { build: settled, request });
        }
      };
      // The call itself may throw, and that is a failed build like any other.
      (async () => build())().then(
        (built) => settle({ ...built, status: "built" }),
        (error: unknown) =>
          settle({ message: reasonOf(error), status: "failed" })
      );
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const stores = new WeakMap<Workspace, WorkingBuilds>();

/**
 * The working builds of a workspace, made the first time they are asked
 * for. They outlast the Proof screen, which is taken down whenever a person
 * looks at another place: a build that is running is still running on the
 * way back, and still cannot be started a second time.
 */
export const workingBuildsOf = (workspace: Workspace): WorkingBuilds => {
  let builds = stores.get(workspace);
  if (!builds) {
    builds = createWorkingBuilds();
    stores.set(workspace, builds);
  }
  return builds;
};
