// Memoized reachability over one directed adjacency, shared by change
// coupling (file and package static paths). Each node's reachable set is
// computed once, so answering for every pair costs one traversal per node.

export function adjacency(
  edges: Iterable<[string, string]>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    let targets = out.get(from);
    if (targets === undefined) {
      targets = new Set();
      out.set(from, targets);
    }
    targets.add(to);
  }
  return out;
}

export class Reachability {
  private readonly memo = new Map<string, Set<string>>();

  private readonly out: Map<string, Set<string>>;
  constructor(out: Map<string, Set<string>>) {
    this.out = out;
  }

  /** True when a path exists from a to b or from b to a. */
  connected(a: string, b: string): boolean {
    return this.reachable(a).has(b) || this.reachable(b).has(a);
  }

  private reachable(from: string): Set<string> {
    const cached = this.memo.get(from);
    if (cached !== undefined) {
      return cached;
    }
    const seen = new Set<string>();
    const queue = [from];
    for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
      for (const next of this.out.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    this.memo.set(from, seen);
    return seen;
  }
}
