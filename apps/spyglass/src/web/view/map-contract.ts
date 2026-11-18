import type { RenderQuality } from "../settings/chart-settings";

export interface SelectionRef {
  fileId?: string;
  territoryId: string;
}

type MapNodeKind = "labels" | "layer" | "marks" | "stage";

export interface CompositionNode {
  counts?: Record<string, number>;
  enabled: boolean;
  id: string;
  kind: MapNodeKind;
  updateMs: number | null;
}

export interface RenderStatus {
  adapted: boolean;
  backend: "webgpu" | "webgl";
  failure: string | null;
  frameMs: number | null;
  globalIlluminationAvailable: boolean;
  postProcessing: boolean;
  quality: RenderQuality;
}

export interface MapHandle {
  describe: () => CompositionNode[];
  focus: (selection: SelectionRef | null) => void;
  getRenderStatus: () => RenderStatus;
  zoom: (factor: number) => void;
}
