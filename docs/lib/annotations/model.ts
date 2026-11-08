export interface Point {
  x: number;
  y: number;
}

export interface Anchor extends Point {
  id: string;
}

export interface TextSegment {
  blockId: string;
  end: number;
  prefix: string;
  quote: string;
  start: number;
  suffix: string;
}

export interface TextTarget {
  segments: TextSegment[];
}

export interface TextRect extends Point {
  height: number;
  width: number;
}

export interface TextAnchors {
  captureSelection: () => TextTarget | null;
  dispose: () => void;
  resolveTarget: (target: TextTarget) => TextRect[] | null;
  targetAtPoint: (point: Point) => TextTarget | null;
  targetForStroke: (points: Point[]) => TextTarget | null;
}

/**
 * Share links store a mark kind as its index in this list. Append new kinds;
 * never reorder or remove one, or existing links decode as the wrong kind.
 */
export const MARK_KINDS = [
  "draw",
  "text",
  "highlight",
  "underline",
  "arrow",
  "comment",
] as const;

export const TEXT_MARK_KINDS = ["highlight", "underline", "comment"] as const;

export const LIMITS = {
  marks: 300,
  noteLength: 2000,
  pointsPerStroke: 2000,
  quoteLength: 8000,
  segmentsPerTarget: 32,
} as const;

export interface Mark {
  anchor: Anchor;
  color: string;
  id: string;
  kind: (typeof MARK_KINDS)[number];
  points: Point[];
  target?: TextTarget;
  text: string;
}

export interface AnnotationDocument {
  marks: Mark[];
  version: 1;
}

export interface ShareResult {
  bytes: number;
  message: string;
  qrReady: boolean;
  url?: string;
}
