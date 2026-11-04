import { InMemoryStateStore, JsonStateStore } from "@foundry.sh/marbles/engine";

type Write = InMemoryStateStore["write"];
type Append = InMemoryStateStore["append"];

/**
 * Whether a run-store write carries a run result: the write a full disk
 * fails. A running run appends each observation to its log; its settled
 * record carries them all.
 */
function carriesResult(
  collection: Parameters<Write>[0],
  value: Parameters<Write>[2]
): boolean {
  if (collection === "observations") {
    const { observation } = value as { observation?: { kind: string } };
    return observation?.kind === "result";
  }
  const { observations = [] } = value as {
    observations?: { kind: string }[];
  };
  return (
    collection === "executions" &&
    observations.some((observation) => observation.kind === "result")
  );
}

/** An in-memory run store whose result writes fail while `failing`, like a full disk. */
export class FlakyStateStore extends InMemoryStateStore {
  failing = false as boolean;

  override append(...[collection, key, entry]: Parameters<Append>): void {
    if (this.failing && carriesResult(collection, entry)) {
      throw new Error("disk full");
    }
    super.append(collection, key, entry);
  }

  override write(...[collection, key, value]: Parameters<Write>): void {
    if (this.failing && carriesResult(collection, value)) {
      throw new Error("disk full");
    }
    super.write(collection, key, value);
  }
}

/** The durable (JSON) run store, whose result writes fail while `failing`. */
export class FlakyJsonStateStore extends JsonStateStore {
  failing = false as boolean;

  override append(...[collection, key, entry]: Parameters<Append>): void {
    if (this.failing && carriesResult(collection, entry)) {
      throw new Error("disk full");
    }
    super.append(collection, key, entry);
  }

  override write(...[collection, key, value]: Parameters<Write>): void {
    if (this.failing && carriesResult(collection, value)) {
      throw new Error("disk full");
    }
    super.write(collection, key, value);
  }
}
