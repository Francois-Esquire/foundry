export interface Shape {
  width: number;
  height: number;
}

export function area(shape: Shape): number {
  return shape.width * shape.height;
}

export function perimeter(shape: Shape): number {
  return 2 * (shape.width + shape.height);
}
