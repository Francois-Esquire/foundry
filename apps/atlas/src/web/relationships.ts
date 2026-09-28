import { neighborhoodAffinity } from "./codex/bindings";

export interface FileRelationship {
  attraction: number;
  concepts: string[];
  imports: number;
  source: string;
  target: string;
}

export function fileRelationships(
  ids: string[],
  imports: { source: string; target: string }[],
  participation: ReadonlyMap<string, readonly string[]>
): FileRelationship[] {
  const known = new Set(ids);
  const pairs = new Map<string, FileRelationship>();
  const pair = (left: string, right: string) => {
    const [source = "", target = ""] = [left, right].sort();
    const key = JSON.stringify([source, target]);
    const value = pairs.get(key) ?? {
      attraction: 0,
      concepts: [],
      imports: 0,
      source,
      target,
    };
    pairs.set(key, value);
    return value;
  };
  const seen = new Set<string>();
  for (const edge of imports) {
    const key = JSON.stringify([edge.source, edge.target]);
    if (
      edge.source === edge.target ||
      !known.has(edge.source) ||
      !known.has(edge.target) ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    pair(edge.source, edge.target).imports += 1;
  }
  const participants = new Map<string, string[]>();
  for (const id of [...known].sort()) {
    for (const concept of [...new Set(participation.get(id) ?? [])].sort()) {
      const members = participants.get(concept) ?? [];
      members.push(id);
      participants.set(concept, members);
    }
  }
  for (const [concept, members] of [...participants].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    for (const [i, a] of members.entries()) {
      for (const b of members.slice(i + 1)) {
        const relation = pair(a, b);
        relation.concepts.push(concept);
        relation.attraction += 1 / (members.length - 1);
      }
    }
  }
  return [...pairs.values()]
    .map((relation) => ({
      ...relation,
      attraction: neighborhoodAffinity(relation.imports, relation.attraction),
    }))
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
    );
}
