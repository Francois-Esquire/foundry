import type { Frame, FramePass, Target, Texture } from "vgpu";
import type { Point } from "../../../data/chart";
import type { DebrisLight } from "../land/debris";
import type { MapName } from "../maps/map-params";
import type { MapFrame } from "../maps/map-uniforms";

export type RoadRank = "main" | "street" | "lane" | "path";

export const ROAD_WIDTH: Readonly<Record<RoadRank, number>> = {
  lane: 1,
  main: 2.5,
  path: 0.5,
  street: 1.5,
};

export interface Road {
  readonly folder: string | null;
  readonly id: number;
  readonly island: string;
  readonly points: readonly Point[];
  readonly rank: RoadRank;
  readonly width: number;
}

export type ParcelKind =
  | "lot"
  | "plaza"
  | "pitch"
  | "playground"
  | "track"
  | "field"
  | "garden"
  | "shrine"
  | "parking";

export interface Parcel {
  readonly edge: "none" | "wall" | "hedge" | "fence";
  readonly id: number;
  readonly island: string;
  readonly kind: ParcelKind;
  readonly outline: readonly Point[];
  readonly road: number | null;
}

export type BuildingKind =
  | "house"
  | "pair"
  | "walkup"
  | "block"
  | "tower"
  | "store"
  | "civic"
  | "station"
  | "school"
  | "utility"
  | "shrine"
  | "stand"
  | "boathouse"
  | "lighthouse";

export interface Building {
  readonly at: Point;
  readonly files: readonly string[];
  readonly half: readonly [number, number];
  readonly id: number;
  readonly island: string;
  readonly kind: BuildingKind;
  readonly parcel: number;
  readonly storeys: number;
  readonly turn: number;
}

export type ZoneKind =
  | "core"
  | "garden"
  | "field"
  | "grove"
  | "pines"
  | "meadow"
  | "shore";

export interface Zone {
  readonly island: string;
  readonly kind: ZoneKind;
  readonly outline: readonly Point[];
}

export interface PlannedTree {
  readonly at: Point;
  readonly kind: "street" | "grove" | "pine" | "garden";
  readonly size: number;
}

export interface WorldPlan {
  readonly buildingOf: ReadonlyMap<string, number>;
  readonly buildings: readonly Building[];
  readonly parcels: readonly Parcel[];
  readonly poles: readonly { readonly at: Point; readonly road: number }[];
  readonly roads: readonly Road[];
  readonly trees: readonly PlannedTree[];
  readonly zones: readonly Zone[];
}

export interface WorldLayer {
  compile: (film: Target) => Promise<void>;
  dispose: () => void;
  draw: (pass: FramePass, light: DebrisLight, grid: MapFrame) => void;
  set: (plan: WorldPlan) => void;
  settle: (
    frame: Frame,
    grid: MapFrame,
    textures: Readonly<Record<MapName, Texture>>
  ) => void;
}
