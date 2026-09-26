import type { Node, Project, SourceFile } from "ts-morph";

import { ts } from "ts-morph";

// V12.6 workspace reference index: every node that names one of the given
// declarations, found in a single walk over the workspace program instead
// of one language-service search per symbol. Each identifier is resolved
// through the checker and its alias chain, so an aliased import, a barrel
// re-export, a namespace member, a destructured module namespace, and a
// JSDoc `{@link}` all land on the original declaration — the same nodes
// `findReferencesAsNodes` yields, at a fixed cost per workspace.

export interface ReferenceTarget<K> {
  key: K;
  node: Node;
}

function resolveAlias(
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): ts.Symbol | undefined {
  let current = symbol;
  for (let hops = 0; hops < 32; hops += 1) {
    if (!(current.flags & ts.SymbolFlags.Alias)) {
      return current;
    }
    const next = checker.getAliasedSymbol(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return undefined;
}

/**
 * The node `findReferencesAsNodes` would return for this span. ts-morph's
 * `DocumentSpan.getNode` compares each node's width against the span's
 * *end* offset, so it returns the deepest node starting at `start` unless
 * some ancestor's width happens to equal `start + width`, in which case that
 * ancestor wins (an `import { A, B }` list, say). The published usage
 * numbers were measured under that rule; reproduce it exactly, and change
 * both together if it is ever corrected.
 */
function nodeAt(file: SourceFile, start: number, width: number): Node {
  const end = start + width;
  let best: Node = file;
  let found = false;
  let next: Node | undefined = file;
  while (next !== undefined) {
    if (!found) {
      best = next;
    }
    if (next.getStart() === start && next.getWidth() === end) {
      best = next;
      found = true;
    } else if (found) {
      break;
    }
    next = next.getChildAtPos(start);
  }
  return best;
}

/**
 * Reference nodes per target key, in workspace file order then position.
 * References inside the declaring file are included; callers filter by
 * boundary exactly as they do for `findReferencesAsNodes`.
 */
export function indexWorkspaceReferences<K>(
  project: Project,
  targets: ReferenceTarget<K>[]
): Map<K, Node[]> {
  const checker = project.getTypeChecker().compilerObject;
  const byDeclaration = new Map<ts.Node, K[]>();
  for (const target of targets) {
    const keys = byDeclaration.get(target.node.compilerNode) ?? [];
    keys.push(target.key);
    byDeclaration.set(target.node.compilerNode, keys);
  }
  const references = new Map<K, Node[]>();
  for (const target of targets) {
    references.set(target.key, []);
  }
  if (targets.length === 0) {
    return references;
  }

  // The language service searches the whole compiler program, which holds
  // files the project never added — a `dist/*.d.ts` reached through a
  // package's `types` condition. Those counted as consumers before and must
  // still; wrap them without adding them to the project, as ts-morph does
  // for its own reference entries. Only node_modules is skipped.
  const factory = (
    project as unknown as {
      _context: {
        compilerFactory: {
          getSourceFile: (
            file: ts.SourceFile,
            options: { markInProject: boolean }
          ) => SourceFile;
        };
      };
    }
  )._context.compilerFactory;
  for (const compilerSourceFile of project
    .getProgram()
    .compilerObject.getSourceFiles()) {
    if (compilerSourceFile.fileName.includes("/node_modules/")) {
      continue;
    }
    const file = factory.getSourceFile(compilerSourceFile, {
      markInProject: false,
    });
    const compilerFile = file.compilerNode;
    const seen = new Set<number>();

    const record = (
      identifier: ts.Identifier,
      symbol: ts.Symbol | undefined
    ) => {
      if (symbol === undefined) {
        return;
      }
      const candidates = [symbol];
      const resolved = resolveAlias(checker, symbol);
      if (resolved !== undefined && resolved !== symbol) {
        candidates.push(resolved);
      }
      let keys: K[] | undefined;
      for (const candidate of candidates) {
        for (const declaration of candidate.declarations ?? []) {
          const found = byDeclaration.get(declaration);
          if (found === undefined) {
            continue;
          }
          keys ??= [];
          for (const key of found) {
            if (!keys.includes(key)) {
              keys.push(key);
            }
          }
        }
      }
      if (keys === undefined) {
        return;
      }
      const start = identifier.getStart(compilerFile);
      if (seen.has(start)) {
        return;
      }
      seen.add(start);
      const node = nodeAt(file, start, identifier.getWidth(compilerFile));
      for (const key of keys) {
        references.get(key)?.push(node);
      }
    };

    const visitIdentifier = (identifier: ts.Identifier) => {
      const parent = identifier.parent;
      if (
        ts.isShorthandPropertyAssignment(parent) &&
        parent.name === identifier
      ) {
        record(identifier, checker.getShorthandAssignmentValueSymbol(parent));
        return;
      }
      if (
        ts.isBindingElement(parent) &&
        parent.name === identifier &&
        parent.propertyName === undefined &&
        ts.isObjectBindingPattern(parent.parent)
      ) {
        // `const { x } = await import("pkg")` names the export through the
        // namespace type; the binding's own symbol is only the local.
        record(
          identifier,
          checker.getTypeAtLocation(parent.parent).getProperty(identifier.text)
        );
      }
      record(identifier, checker.getSymbolAtLocation(identifier));
    };

    const walk = (node: ts.Node) => {
      const docs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
      if (docs !== undefined) {
        const walkDoc = (doc: ts.Node) => {
          if (ts.isIdentifier(doc)) {
            visitIdentifier(doc);
          }
          ts.forEachChild(doc, walkDoc);
        };
        for (const doc of docs) {
          walkDoc(doc);
        }
      }
      if (ts.isIdentifier(node)) {
        visitIdentifier(node);
      }
      ts.forEachChild(node, walk);
    };
    walk(compilerFile);
  }
  return references;
}
