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

export interface Mark {
  anchor: Anchor;
  color: string;
  id: string;
  kind: "draw" | "text" | "highlight" | "underline" | "arrow" | "comment";
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
