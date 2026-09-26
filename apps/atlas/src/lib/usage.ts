import { Node, SyntaxKind, ts } from "ts-morph";

import type { UsageContext } from "./types";

export interface ClassifiedReference {
  context: UsageContext;
  space: "type" | "value" | "unknown";
}

/** Classify a non-import reference node by its semantic role. */
export function classifyReference(ref: Node): ClassifiedReference {
  const heritage = classifyHeritage(ref);
  if (heritage) {
    return heritage;
  }

  if (ts.isPartOfTypeNode(ref.compilerNode)) {
    return { context: typeContext(ref), space: "type" };
  }

  const parent = ref.getParent();
  if (parent) {
    if (Node.isCallExpression(parent) && parent.getExpression() === ref) {
      return { context: "call", space: "value" };
    }
    if (Node.isNewExpression(parent) && parent.getExpression() === ref) {
      return { context: "construct", space: "value" };
    }
    if (Node.isExpression(ref)) {
      return { context: "value-reference", space: "value" };
    }
  }
  return { context: "unknown", space: "unknown" };
}

function classifyHeritage(ref: Node): ClassifiedReference | undefined {
  const expression = ref.getFirstAncestorByKind(
    SyntaxKind.ExpressionWithTypeArguments
  );
  if (expression?.getExpression() !== ref) {
    return undefined;
  }
  const clause = expression.getParent();
  if (!Node.isHeritageClause(clause)) {
    return undefined;
  }
  if (clause.getToken() === SyntaxKind.ImplementsKeyword) {
    return { context: "implements", space: "type" };
  }
  const owner = clause.getParent();
  const isClass =
    Node.isClassDeclaration(owner) || Node.isClassExpression(owner);
  return { context: "extends", space: isClass ? "value" : "type" };
}

function typeContext(ref: Node): UsageContext {
  let top: Node = ref;
  for (;;) {
    const parent = top.getParent();
    if (!(parent && ts.isPartOfTypeNode(parent.compilerNode))) {
      break;
    }
    top = parent;
  }
  const owner = top.getParent();
  if (!owner) {
    return "type-reference";
  }
  if (Node.isParameterDeclaration(owner)) {
    return "parameter-type";
  }
  if (Node.isPropertySignature(owner) || Node.isPropertyDeclaration(owner)) {
    return "property-type";
  }
  if (
    (Node.isFunctionDeclaration(owner) ||
      Node.isFunctionExpression(owner) ||
      Node.isArrowFunction(owner) ||
      Node.isMethodDeclaration(owner) ||
      Node.isMethodSignature(owner)) &&
    owner.getReturnTypeNode() === top
  ) {
    return "return-type";
  }
  return "type-reference";
}
