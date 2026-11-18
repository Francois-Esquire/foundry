import { InMemoryStateStore, JsonStateStore } from "@foundry.sh/marbles/engine";

type Write = InMemoryStateStore["write"];
type Append = InMemoryStateStore["append"];

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
