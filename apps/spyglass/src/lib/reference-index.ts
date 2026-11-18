import type { Node, Project, SourceFile } from "ts-morph";

import { ts } from "ts-morph";

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
    // biome-ignore lint/suspicious/noBitwiseOperators: TypeScript exposes these properties as bit flags.
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
      const visitCandidate = () => {
        keys = recordCandidate<K>(candidates, byDeclaration, keys);
      };
      visitCandidate();
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
      const { parent } = identifier;
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

function recordCandidate<K>(
  candidates: ts.Symbol[],
  byDeclaration: Map<ts.Node, K[]>,
  initialKeys: K[] | undefined
) {
  let keys = initialKeys;
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
  return keys;
}
