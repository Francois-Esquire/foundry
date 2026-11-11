import type { FaceId, SourceId } from "~/typeface/face";
import { findFace, findSource, type TypefaceProject } from "~/typeface/project";
import type { FontReader, OpenFace } from "~/typeface/reading";
import { pinnedFaceView } from "./pinned-face";

/**
 * The faces the workspace holds open. A source font's faces are opened once
 * and shared; a pinned instance is a view over its variable face.
 */
export interface OpenFaces {
  /** Takes over faces that were opened while checking an import, in face order. */
  adopt(sourceId: SourceId, faces: readonly OpenFace[]): void;
  /** Closes every face that is open, of every source font. */
  closeAll(): void;
  /** Throws ProjectError when the project has no such face. */
  open(project: TypefaceProject, faceId: FaceId): OpenFace;
  /** Closes everything opened from a source font. */
  release(sourceId: SourceId): void;
}

interface OpenSource {
  readonly byIndex: Map<number, OpenFace>;
  readonly pinned: Map<FaceId, OpenFace>;
}

export const createOpenFaces = (reader: FontReader): OpenFaces => {
  const sources = new Map<SourceId, OpenSource>();
  const release = (sourceId: SourceId) => {
    for (const face of sources.get(sourceId)?.byIndex.values() ?? []) {
      face.close();
    }
    sources.delete(sourceId);
  };
  const sourceFor = (sourceId: SourceId): OpenSource => {
    let source = sources.get(sourceId);
    if (!source) {
      source = { byIndex: new Map(), pinned: new Map() };
      sources.set(sourceId, source);
    }
    return source;
  };
  return {
    adopt(sourceId, faces) {
      const { byIndex } = sourceFor(sourceId);
      for (const [index, face] of faces.entries()) {
        byIndex.set(index, face);
      }
    },
    closeAll() {
      for (const sourceId of [...sources.keys()]) {
        release(sourceId);
      }
    },
    open(project, faceId) {
      const face = findFace(project, faceId);
      const source = sourceFor(face.sourceId);
      let opened = source.byIndex.get(face.index);
      if (!opened) {
        opened = reader.open(
          findSource(project, face.sourceId).bytes,
          face.index
        );
        source.byIndex.set(face.index, opened);
      }
      if (!face.pinned) {
        return opened;
      }
      let view = source.pinned.get(face.id);
      if (!view) {
        view = pinnedFaceView(opened, face.pinned);
        source.pinned.set(face.id, view);
      }
      return view;
    },
    release,
  };
};
