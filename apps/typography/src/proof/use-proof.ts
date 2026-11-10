/** The asynchronous steps of the Proof screen: building a working face, proving a font, loading it into the browser. */
import { useCallback, useEffect, useState } from "react";
import { keptCharacters } from "~/export/build-run";
import { shapingSamples } from "~/export/shaping-samples";
import type { FaceId } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";
import { useWorkspace } from "~/workspace/react";
import { useFontBuilder, useFontReader } from "~/workspace/services";
import { type Proof, proveFont } from "./proof";
import type { ProofFont } from "./proof-subject";
import { workingRequest } from "./working-build";

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export type WorkingBuild =
  | { readonly status: "idle" }
  | { readonly status: "building" }
  | {
      readonly status: "built";
      readonly font: ProofFont;
      /** The project the font was built from, so a later change can be seen. */
      readonly project: TypefaceProject;
    }
  | { readonly status: "failed"; readonly message: string };

interface Keyed {
  readonly build: WorkingBuild;
  readonly faceId: FaceId;
}

/** Builds a face as the project has it now, when asked. One build is kept per face shown. */
export const useWorkingBuild = (
  faceId: FaceId | undefined,
  label: string
): { readonly build: WorkingBuild; readonly start: () => void } => {
  const workspace = useWorkspace();
  const builder = useFontBuilder();
  const [keyed, setKeyed] = useState<Keyed>();

  const start = useCallback(() => {
    if (faceId === undefined) {
      return;
    }
    const { project } = workspace.getState();
    const settle = (build: WorkingBuild) => setKeyed({ build, faceId });
    settle({ status: "building" });
    (async () => {
      const request = workingRequest(project, faceId);
      const built = await builder.build(request);
      settle({
        font: {
          builtAt: new Date().toISOString(),
          bytes: built.bytes,
          exported: false,
          faceId,
          fileName: `${label}, working face`,
          id: crypto.randomUUID(),
          request,
          samples: shapingSamples(
            keptCharacters(request, workspace.openFace(faceId).characters())
          ),
        },
        project,
        status: "built",
      });
    })().catch((error: unknown) =>
      settle({ message: reasonOf(error), status: "failed" })
    );
  }, [builder, faceId, label, workspace]);

  return {
    build: keyed && keyed.faceId === faceId ? keyed.build : { status: "idle" },
    start,
  };
};

export type ProofState =
  | { readonly status: "proving" }
  | { readonly status: "proved"; readonly proof: Proof }
  | { readonly status: "failed"; readonly message: string };

interface ProvedFont {
  readonly fontId: string;
  readonly state: ProofState;
}

/** Reopens the font's bytes and compares them with the source, whenever the font changes. */
export const useProof = (font: ProofFont): ProofState => {
  const workspace = useWorkspace();
  const builder = useFontBuilder();
  const reader = useFontReader();
  const [proved, setProved] = useState<ProvedFont>();
  useEffect(() => {
    let current = true;
    const settle = (state: ProofState) => {
      if (current) {
        setProved({ fontId: font.id, state });
      }
    };
    (async () => {
      settle({
        proof: await proveFont({
          builder,
          bytes: font.bytes,
          reader,
          request: font.request,
          samples: font.samples.map((entry) => entry.sample),
          // Throws when the face has left the project since the font was built.
          source: workspace.openFace(font.faceId),
        }),
        status: "proved",
      });
    })().catch((error: unknown) =>
      settle({ message: reasonOf(error), status: "failed" })
    );
    return () => {
      current = false;
    };
  }, [builder, font, reader, workspace]);
  return proved?.fontId === font.id ? proved.state : { status: "proving" };
};

export type BrowserFont =
  | { readonly status: "loading" }
  /** The CSS family that sets text in the font's own bytes. */
  | { readonly status: "loaded"; readonly family: string }
  | { readonly status: "refused"; readonly message: string };

interface LoadedFont {
  readonly font: BrowserFont;
  readonly fontId: string;
}

/**
 * Registers the font's real bytes with the browser under a family of its
 * own, and removes it again when the font is no longer shown. Text is set in
 * it only once the browser has accepted it.
 */
export const useBrowserFont = (font: ProofFont): BrowserFont => {
  const [loaded, setLoaded] = useState<LoadedFont>();
  useEffect(() => {
    const family = `Typography Proof ${font.id}`;
    // A copy, because the browser may keep the buffer it is given.
    const face = new FontFace(family, font.bytes.slice().buffer);
    let current = true;
    face.load().then(
      () => {
        if (current) {
          document.fonts.add(face);
          setLoaded({ font: { family, status: "loaded" }, fontId: font.id });
        }
      },
      (error: unknown) => {
        if (current) {
          setLoaded({
            font: { message: reasonOf(error), status: "refused" },
            fontId: font.id,
          });
        }
      }
    );
    return () => {
      current = false;
      document.fonts.delete(face);
    };
  }, [font]);
  return loaded?.fontId === font.id ? loaded.font : { status: "loading" };
};
