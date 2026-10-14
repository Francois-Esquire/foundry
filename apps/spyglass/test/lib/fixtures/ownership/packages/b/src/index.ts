import type { Label, Observation, Shape, Signal, Store } from "@w/a";

export class SqlStore implements Store {
  private readonly rows: Record<string, string> = {};
  get(id: string): string | undefined {
    return this.rows[id];
  }
  put(id: string, value: string): void {
    this.rows[id] = value;
  }
  size(): number {
    return Object.keys(this.rows).length;
  }
}

// Same file, same package, no structural relationship to Store.
export class Unrelated {
  first(): number {
    return 1;
  }
  second(): number {
    return 2;
  }
}

export function migrate(store: Store): number {
  return store.size();
}

export function emit(signal: Signal): number {
  return signal.level;
}
export function raise(signal: Signal): number {
  return signal.level + 1;
}
export function lower(signal: Signal): number {
  return signal.level - 1;
}
export function mute(signal: Signal): number {
  return signal.level * 0;
}
export function amplify(signal: Signal): number {
  return signal.level * 2;
}
export function attenuate(signal: Signal): number {
  return signal.level / 2;
}

export interface Box1 {
  shape: Shape;
}
export interface Box2 {
  shape: Shape;
}
export interface Box3 {
  shape: Shape;
}
export interface Box4 {
  shape: Shape;
}
export interface Box5 {
  shape: Shape;
}
export interface Box6 {
  shape: Shape;
}
export interface Box7 {
  shape: Shape;
}
export interface Box8 {
  shape: Shape;
}
export interface Box9 {
  shape: Shape;
}

export function render(): string {
  const a: Label = { text: "a" };
  const b: Label = { text: "b" };
  const c: Label = { text: "c" };
  const d: Label = { text: "d" };
  const e: Label = { text: "e" };
  const f: Label = { text: "f" };
  const g: Label = { text: "g" };
  const h: Label = { text: "h" };
  const i: Label = { text: "i" };
  const j: Label = { text: "j" };
  return [a, b, c, d, e, f, g, h, i, j].map((label) => label.text).join("");
}

export interface StoredObservation {
  id: string;
  status: string;
  attempts: number;
  output: string;
  storedAt: number;
}

export function toStored(observation: Observation): StoredObservation {
  return { ...observation, storedAt: 0 };
}

export function fromStored(stored: StoredObservation): Observation {
  const { storedAt: _storedAt, ...observation } = stored;
  return observation;
}
