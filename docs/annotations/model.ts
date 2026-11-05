export interface Point {
  x: number;
  y: number;
}

export interface Anchor extends Point {
  id: string;
}

export interface Mark {
  anchor: Anchor;
  color: string;
  id: string;
  kind: "draw" | "text";
  points: Point[];
  text: string;
}

export interface AnnotationDocument {
  marks: Mark[];
  version: 1;
}
