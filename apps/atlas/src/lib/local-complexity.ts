import { relative } from "node:path";
import type { ParameterDeclaration, ParameteredNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";
import type { Boundary } from "./boundary";
import { boundaryContains, toPosix } from "./boundary";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  FunctionComplexity,
  FunctionKind,
  LocalComplexityMetrics,
  LocalComplexityReport,
  LocalComplexitySummary,
  MetricAggregate,
  MetricDistribution,
} from "./types";

// Local complexity: how each function is shaped, measured as raw structural
// facts — never scored, labeled, or gated. All metric semantics live in this
// module. Each source file is walked once with a stack of active function
// records; every node contributes to the innermost enclosing function only,
// so nested function bodies never inflate a parent's decisions, nesting,
// exits, or statements — the parent sees them through `callbacks` alone.

/** A collected surface symbol a function can belong to. */
export interface ComplexityOwner {
  exported: boolean;
  node: Node;
  packagePublic: boolean;
  symbolId: string;
}

function functionKind(node: Node): FunctionKind | undefined {
  if (Node.isFunctionDeclaration(node)) {
    return "function";
  }
  if (Node.isFunctionExpression(node)) {
    return "function-expression";
  }
  if (Node.isArrowFunction(node)) {
    return "arrow";
  }
  if (Node.isMethodDeclaration(node)) {
    return "method";
  }
  if (Node.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (Node.isGetAccessorDeclaration(node)) {
    return "getter";
  }
  if (Node.isSetAccessorDeclaration(node)) {
    return "setter";
  }
  return undefined;
}

function bodyOf(node: Node): Node | undefined {
  if (Node.isBodied(node)) {
    return node.getBody();
  }
  if (Node.isBodyable(node)) {
    return node.getBody();
  }
  return undefined;
}

function functionName(node: Node): string {
  if (Node.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (Node.hasName(node)) {
    return node.getName();
  }
  const parent = node.getParent();
  if (parent !== undefined) {
    if (
      Node.isVariableDeclaration(parent) ||
      Node.isPropertyDeclaration(parent)
    ) {
      return parent.getName();
    }
    if (Node.isPropertyAssignment(parent)) {
      return parent.getName();
    }
  }
  return "<anonymous>";
}

/**
 * Annotated boolean semantics only: `boolean`, `true | false`, or an alias
 * or union resolving to boolean literals. Unannotated parameters are never
 * counted (no contextual inference), and only non-keyword annotations touch
 * the type checker — keeps the pass cheap on large packages.
 */
function isBooleanParameter(parameter: ParameterDeclaration): boolean {
  const annotation = parameter.getTypeNode();
  if (annotation === undefined) {
    return false;
  }
  if (annotation.getKind() === SyntaxKind.BooleanKeyword) {
    return true;
  }
  if (
    annotation.getKind() !== SyntaxKind.UnionType &&
    annotation.getKind() !== SyntaxKind.TypeReference
  ) {
    return false;
  }
  const type = annotation.getType();
  if (type.isBoolean()) {
    return true;
  }
  return (
    type.isUnion() &&
    type.getUnionTypes().every((member) => member.isBooleanLiteral())
  );
}

function booleanParameters(node: Node): number {
  if (!Node.isParametered(node)) {
    return 0;
  }
  let count = 0;
  for (const parameter of node.getParameters()) {
    if (isBooleanParameter(parameter)) {
      count += 1;
    }
  }
  return count;
}

/**
 * `parameters.boolean` of every function in the boundary, keyed by function
 * id, measured on `project`. A package-local project resolves an annotation
 * naming another package's type as non-boolean; workspace derivation calls
 * this on the shared program to restore the workspace answer.
 */
export function booleanParameterCounts(
  project: Project,
  boundary: Boundary
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of project.getSourceFiles()) {
    if (!boundaryContains(boundary, file.getFilePath())) {
      continue;
    }
    if (file.isDeclarationFile()) {
      continue;
    }
    const relFile = toPosix(relative(boundary.root, file.getFilePath()));
    file.forEachDescendant((node) => {
      if (functionKind(node) === undefined || bodyOf(node) === undefined) {
        return;
      }
      const { line, column } = file.getLineAndColumnAtPos(node.getStart());
      counts.set(
        `${relFile}#L${line}C${column}#${functionName(node)}`,
        booleanParameters(node)
      );
    });
  }
  return counts;
}

/**
 * Executable statements: everything a reader steps through. Blocks carry no
 * behavior of their own; interfaces and type aliases are erased; nested
 * function declarations are separate analysis units.
 */
const STATEMENT_KINDS = new Set<SyntaxKind>([
  SyntaxKind.VariableStatement,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.IfStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ContinueStatement,
  SyntaxKind.BreakStatement,
  SyntaxKind.ReturnStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.LabeledStatement,
  SyntaxKind.ThrowStatement,
  SyntaxKind.TryStatement,
  SyntaxKind.DebuggerStatement,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.EnumDeclaration,
]);

function emptyMetrics(): LocalComplexityMetrics {
  return {
    async: { async: false, awaits: 0, generator: false, yields: 0 },
    callbacks: { maxDepth: 0, nestedFunctions: 0 },
    decisions: {
      cases: 0,
      catches: 0,
      controlFlow: 0,
      defaults: 0,
      elseIfs: 0,
      expression: 0,
      ifs: 0,
      logical: 0,
      loops: 0,
      switches: 0,
      ternaries: 0,
      total: 0,
    },
    exceptions: { catches: 0, finals: 0, tries: 0 },
    exits: { breaks: 0, continues: 0, returns: 0, throws: 0 },
    loops: { doWhile: 0, for: 0, forIn: 0, forOf: 0, total: 0, while: 0 },
    nesting: { max: 0 },
    parameters: { boolean: 0, defaulted: 0, optional: 0, rest: 0, total: 0 },
    statements: 0,
  };
}

function isElseIf(node: Node): boolean {
  const parent = node.getParent();
  return (
    parent !== undefined &&
    Node.isIfStatement(parent) &&
    parent.getElseStatement() === node
  );
}

const NESTING_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ForStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.TryStatement,
]);

/**
 * Control-flow constructs that deepen nesting for their descendants. An
 * `else if` continues the same decision ladder and deliberately does not
 * deepen; a chain of else-ifs reads flat.
 */
function deepensNesting(node: Node): boolean {
  if (node.getKind() === SyntaxKind.IfStatement) {
    return !isElseIf(node);
  }
  return NESTING_KINDS.has(node.getKind());
}

interface Frame {
  controlDepth: number;
  record: FunctionComplexity;
}

const LOOP_FIELDS: Partial<
  Record<SyntaxKind, "for" | "forOf" | "forIn" | "while" | "doWhile">
> = {
  [SyntaxKind.ForStatement]: "for",
  [SyntaxKind.ForOfStatement]: "forOf",
  [SyntaxKind.ForInStatement]: "forIn",
  [SyntaxKind.WhileStatement]: "while",
  [SyntaxKind.DoStatement]: "doWhile",
};

const EXIT_FIELDS: Partial<
  Record<SyntaxKind, "returns" | "throws" | "breaks" | "continues">
> = {
  [SyntaxKind.ReturnStatement]: "returns",
  [SyntaxKind.ThrowStatement]: "throws",
  [SyntaxKind.BreakStatement]: "breaks",
  [SyntaxKind.ContinueStatement]: "continues",
};

function measure(
  node: Node,
  metrics: LocalComplexityMetrics,
  decisions: AnalysisConfig["localComplexity"]["decisions"]
): void {
  const kind = node.getKind();
  measureEntries(kind, node, metrics, decisions);

  const loopField = LOOP_FIELDS[kind];
  if (loopField !== undefined) {
    metrics.loops[loopField] += 1;
    metrics.loops.total += 1;
    metrics.decisions.loops += 1;
    metrics.decisions.controlFlow += 1;
    metrics.decisions.total += 1;
  }
  const exitField = EXIT_FIELDS[kind];
  if (exitField !== undefined) {
    metrics.exits[exitField] += 1;
  }
  if (STATEMENT_KINDS.has(kind)) {
    metrics.statements += 1;
  }
}

function measureEntries(
  kind: SyntaxKind,
  node: Node,
  metrics: LocalComplexityMetrics,
  decisions: { countLogicalOperators: boolean; countNullishCoalescing: boolean }
) {
  if (kind === SyntaxKind.IfStatement) {
    if (isElseIf(node)) {
      metrics.decisions.elseIfs += 1;
    } else {
      metrics.decisions.ifs += 1;
    }
    metrics.decisions.controlFlow += 1;
    metrics.decisions.total += 1;
  } else {
    measureEntriesEntries(kind, metrics, node, decisions);
  }
}

function measureEntriesEntries(
  kind: SyntaxKind,
  metrics: LocalComplexityMetrics,
  node: Node,
  decisions: { countLogicalOperators: boolean; countNullishCoalescing: boolean }
) {
  if (kind === SyntaxKind.ConditionalExpression) {
    metrics.decisions.ternaries += 1;
    metrics.decisions.expression += 1;
    metrics.decisions.total += 1;
  } else if (kind === SyntaxKind.SwitchStatement) {
    metrics.decisions.switches += 1;
  } else if (kind === SyntaxKind.CaseClause) {
    metrics.decisions.cases += 1;
    metrics.decisions.controlFlow += 1;
    metrics.decisions.total += 1;
  } else if (kind === SyntaxKind.DefaultClause) {
    metrics.decisions.defaults += 1;
  } else if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getKind();
    const counts =
      operator === SyntaxKind.QuestionQuestionToken
        ? decisions.countNullishCoalescing
        : (operator === SyntaxKind.AmpersandAmpersandToken ||
            operator === SyntaxKind.BarBarToken) &&
          decisions.countLogicalOperators;
    if (counts) {
      metrics.decisions.logical += 1;
      metrics.decisions.expression += 1;
      metrics.decisions.total += 1;
    }
  } else if (Node.isTryStatement(node)) {
    metrics.exceptions.tries += 1;
    if (node.getFinallyBlock() !== undefined) {
      metrics.exceptions.finals += 1;
    }
  } else if (kind === SyntaxKind.CatchClause) {
    metrics.exceptions.catches += 1;
    metrics.decisions.catches += 1;
    metrics.decisions.controlFlow += 1;
    metrics.decisions.total += 1;
  } else if (kind === SyntaxKind.AwaitExpression) {
    metrics.async.awaits += 1;
  } else if (kind === SyntaxKind.YieldExpression) {
    metrics.async.yields += 1;
  }
}

function nearestRank(sorted: number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
}

/** Nearest-rank percentiles; shared with churn so every distribution agrees. */
export function distribution(values: number[]): MetricDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    max: sorted.at(-1) ?? 0,
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    p95: nearestRank(sorted, 0.95),
  };
}

function aggregate(values: number[]): MetricAggregate {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    average: values.length === 0 ? 0 : total / values.length,
    distribution: distribution(values),
    total,
  };
}

export function summarize(
  functions: FunctionComplexity[]
): LocalComplexitySummary {
  return {
    controlFlowDecisions: aggregate(
      functions.map((fn) => fn.metrics.decisions.controlFlow)
    ),
    decisions: aggregate(functions.map((fn) => fn.metrics.decisions.total)),
    functionsAnalyzed: functions.length,
    nesting: aggregate(functions.map((fn) => fn.metrics.nesting.max)),
    parameters: aggregate(functions.map((fn) => fn.metrics.parameters.total)),
    statements: aggregate(functions.map((fn) => fn.metrics.statements)),
  };
}

/**
 * Measure the local structural complexity of every function in the boundary
 * using the already-loaded project — one walk per file, no rescans. `owners`
 * ties functions back to collected surface symbols: a function that is the
 * direct implementation of a symbol (the declaration, a variable initializer,
 * or a member of a collected class) inherits its exported/packagePublic
 * status; nested callbacks keep the owner id but report both flags false.
 */
export function analyzeLocalComplexity(
  project: Project,
  boundary: Boundary,
  owners: ComplexityOwner[],
  config: AnalysisConfig = ANALYSIS_CONFIG
): LocalComplexityReport {
  const decisionsPolicy = config.localComplexity.decisions;
  const ownersByNode = new Map<Node, ComplexityOwner>(
    owners.map((owner) => [owner.node, owner])
  );
  const files = project
    .getSourceFiles()
    .filter(
      (file) =>
        boundaryContains(boundary, file.getFilePath()) &&
        !file.isDeclarationFile()
    );

  const functions: FunctionComplexity[] = [];

  for (const file of files) {
    const relFile = toPosix(relative(boundary.root, file.getFilePath()));
    const stack: Frame[] = [];

    const createRecord = (
      node: Node,
      kind: FunctionKind
    ): FunctionComplexity => {
      const { line, column } = file.getLineAndColumnAtPos(node.getStart());
      const name = functionName(node);
      const metrics = emptyMetrics();
      if (Node.isParametered(node)) {
        createRecordParameter(node, metrics);
        metrics.parameters.boolean = booleanParameters(node);
      }
      metrics.async.async = Node.isAsyncable(node) && node.isAsync();
      metrics.async.generator =
        Node.isGeneratorable(node) && node.isGenerator();

      let owner: ComplexityOwner | undefined;
      let current: Node | undefined = node;
      while (current !== undefined && owner === undefined) {
        owner = ownersByNode.get(current);
        current = current.getParent();
      }
      // Direct implementation of the owning symbol: the declaration itself,
      // a variable initializer, or a member of a collected class — and never
      // inside another function. Anything else (array elements, object
      // properties, callbacks) is not itself surface API.
      const direct =
        stack.length === 0 &&
        owner !== undefined &&
        (node === owner.node ||
          node.getParent() === owner.node ||
          Node.isClassDeclaration(owner.node));
      return {
        file: relFile,
        id: `${relFile}#L${line}C${column}#${name}`,
        kind,
        line,
        name,
        ...(owner !== undefined && { ownerSymbolId: owner.symbolId }),
        exported: direct && owner !== undefined ? owner.exported : false,
        metrics,
        packagePublic:
          direct && owner !== undefined ? owner.packagePublic : false,
      };
    };

    const visit = (node: Node): void => {
      const kind = functionKind(node);
      if (kind !== undefined) {
        if (bodyOf(node) === undefined) {
          return; // overload/abstract signature
        }
        analyzeLocalComplexityEntries(stack);
        const record = createRecord(node, kind);
        functions.push(record);
        stack.push({ controlDepth: 0, record });
        node.forEachChild(visit);
        stack.pop();
        return;
      }
      const frame = stack.at(-1);
      if (frame === undefined) {
        node.forEachChild(visit);
        return;
      }
      measure(node, frame.record.metrics, decisionsPolicy);
      const deepens = deepensNesting(node);
      if (deepens) {
        frame.controlDepth += 1;
        if (frame.controlDepth > frame.record.metrics.nesting.max) {
          frame.record.metrics.nesting.max = frame.controlDepth;
        }
      }
      node.forEachChild(visit);
      if (deepens) {
        frame.controlDepth -= 1;
      }
    };

    file.forEachChild(visit);
  }

  functions.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.name.localeCompare(b.name)
  );
  return { functions, summary: summarize(functions) };
}

function createRecordParameter(
  node: ParameteredNode,
  metrics: LocalComplexityMetrics
) {
  for (const parameter of node.getParameters()) {
    metrics.parameters.total += 1;
    if (parameter.hasQuestionToken()) {
      metrics.parameters.optional += 1;
    }
    if (parameter.getInitializer() !== undefined) {
      metrics.parameters.defaulted += 1;
    }
    if (parameter.isRestParameter()) {
      metrics.parameters.rest += 1;
    }
  }
}

function analyzeLocalComplexityEntries(stack: Frame[]) {
  for (const [index, frame] of stack.entries()) {
    frame.record.metrics.callbacks.nestedFunctions += 1;
    const depth = stack.length - index;
    if (depth > frame.record.metrics.callbacks.maxDepth) {
      frame.record.metrics.callbacks.maxDepth = depth;
    }
  }
}
