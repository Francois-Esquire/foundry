import type { Label } from "@w/a";

// Test helpers whose signatures name Label: test-kind behavior, not a center.
export function labelOf(text: string): Label {
  return { text };
}
export function emptyLabel(): Label {
  return { text: "" };
}
export function upperLabel(label: Label): Label {
  return { text: label.text.toUpperCase() };
}
export function lowerLabel(label: Label): Label {
  return { text: label.text.toLowerCase() };
}
export function sameLabel(left: Label, right: Label): boolean {
  return left.text === right.text;
}
export function labelLength(label: Label): number {
  return label.text.length;
}
