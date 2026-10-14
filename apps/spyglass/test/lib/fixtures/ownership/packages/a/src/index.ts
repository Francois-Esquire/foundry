// Distributed implementation contract: seed here, implementations here and in b.
export interface Store {
  get(id: string): string | undefined;
  put(id: string, value: string): void;
  size(): number;
}

export class MemoryStore implements Store {
  private readonly items = new Map<string, string>();
  get(id: string): string | undefined {
    return this.items.get(id);
  }
  put(id: string, value: string): void {
    this.items.set(id, value);
  }
  size(): number {
    return this.items.size;
  }
}

export function openStore(): Store {
  return new MemoryStore();
}

export function useStore(store: Store): number {
  return store.size();
}

// Aligned: everything about Ticket lives here.
export interface Ticket {
  id: string;
  open: boolean;
}

export interface TicketList {
  items: Ticket;
}

export function openTicket(): Ticket {
  return { id: "t", open: true };
}

export function closeTicket(ticket: Ticket): void {
  ticket.open = false;
}

export function escalate(ticket: Ticket): Ticket {
  return { ...ticket, open: true };
}

// Seed here, behavior in b.
export interface Signal {
  level: number;
}

// Seed here, representations in b.
export interface Shape {
  sides: number;
}

// Seed and behavior here, references mostly in b.
export type Label = { text: string };

export function makeLabel(): Label {
  return { text: "" };
}

export function printLabel(label: Label): string {
  return label.text;
}

export function mergeLabels(left: Label, right: Label): Label {
  return { text: left.text + right.text };
}

// Domain concept; b holds the stored representation and its converters.
export interface Observation {
  id: string;
  status: string;
  attempts: number;
  output: string;
}

export function observe(): Observation {
  return { id: "o", status: "ok", attempts: 1, output: "" };
}

export function record(observation: Observation): string {
  return observation.id;
}

// Overlap pair inside the target; each keeps its own ownership analysis.
export interface Snapshot {
  id: string;
  taken: number;
  label: string;
  note: string;
}

export interface SnapshotRecord {
  id: string;
  taken: number;
  label: string;
  note: string;
}

// Too small to infer anything.
export interface Tiny {
  x: number;
}

export const tiny: Tiny = { x: 1 };
