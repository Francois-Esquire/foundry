import type { JsonValue } from "@foundry/lib/json";

export type JsonPrimitive = null | boolean | number | string;

export interface Principal {
  readonly attributes?: Readonly<Record<string, JsonValue>>;
  readonly id: string;
  readonly kind: string;
  readonly version?: string;
}

export type PrincipalMatcher =
  | { readonly kind: "any" }
  | {
      readonly kind: "exact";
      readonly principal: Pick<Principal, "kind" | "id" | "version">;
    }
  | {
      readonly attributes?: Readonly<Record<string, ConstraintBound>>;
      readonly kind: "match";
      readonly principalKind: string;
    };

export type ScopeMatcher =
  | { readonly kind: "any" }
  | { readonly kind: "exact"; readonly value: string }
  | { readonly kind: "prefix"; readonly value: string }
  | { readonly kind: "in"; readonly values: readonly string[] };

export type ConstraintBound =
  | { readonly op: "eq"; readonly value: JsonPrimitive }
  | { readonly op: "in"; readonly values: readonly JsonPrimitive[] }
  | { readonly max?: number; readonly min?: number; readonly op: "range" }
  | { readonly op: "prefix"; readonly value: string }
  | { readonly op: "domainSuffix"; readonly value: string }
  | { readonly op: "commandPrefix"; readonly value: string };

export interface Scope {
  readonly action: string;
  readonly constraints?: Readonly<Record<string, ConstraintBound>>;
  readonly constraintsDigest?: string;
  readonly target: ScopeMatcher;
}

export interface AccessRequest {
  readonly action: string;
  readonly attributes?: Readonly<Record<string, JsonValue>>;
  readonly constraintsDigest?: string;
  readonly invocationId?: string;
  readonly principal: Principal;
  readonly sessionId?: string;
  readonly target: string;
}

export type MatchMode = "allow" | "restrictive";

export interface NarrowOptions {
  readonly isNarrowerDigest?: (
    parentDigest: string,
    childDigest: string
  ) => boolean;
}

const SHELL_METACHARACTERS = /[;&|<>`\r\n$\\]/u;
const LEADING_WHITESPACE = /^\s/u;
const TRAILING_WHITESPACE = /\s$/u;
const DISALLOWED_COMMAND_SPACING = /[ \t]{2,}|\t/u;
const COLLAPSIBLE_WHITESPACE = /[ \t]+/gu;
const SHELL_SEGMENT_SEPARATOR = /[;&|\r\n]+/u;
const INVALID_DOMAIN_CHARACTERS = /[\s/@:]/u;

export function matchesPrincipal(
  matcher: PrincipalMatcher,
  principal: Principal,
  mode: MatchMode = "allow"
): boolean {
  switch (matcher.kind) {
    case "any":
      return true;
    case "exact":
      return matchesExactPrincipal(matcher.principal, principal, mode);
    case "match":
      if (matcher.principalKind !== principal.kind) {
        return false;
      }
      return matchesConstraints(matcher.attributes, principal.attributes, mode);
    default:
      return false;
  }
}

export function isDirectPrincipalGrant(
  holder: PrincipalMatcher,
  principal: Principal
): boolean {
  return (
    holder.kind === "exact" && matchesPrincipal(holder, principal, "allow")
  );
}

export function principalMatcherNarrows(
  child: PrincipalMatcher,
  parent: PrincipalMatcher
): boolean {
  if (parent.kind === "any") {
    return true;
  }
  if (child.kind === "any") {
    return false;
  }
  if (parent.kind === "exact") {
    return (
      child.kind === "exact" &&
      matchesExactPrincipal(parent.principal, child.principal, "allow")
    );
  }
  if (child.kind === "exact") {
    return (
      child.principal.kind === parent.principalKind &&
      Object.keys(parent.attributes ?? {}).length === 0
    );
  }
  if (child.principalKind !== parent.principalKind) {
    return false;
  }
  return constraintsNarrow(child.attributes, parent.attributes);
}

export function covers(
  scope: Scope,
  request: AccessRequest,
  mode: MatchMode = "allow"
): boolean {
  if (scope.action !== request.action) {
    return false;
  }
  if (!matchesTarget(scope.target, request.target)) {
    return false;
  }
  if (
    !matchesDigest(scope.constraintsDigest, request.constraintsDigest, mode)
  ) {
    return false;
  }
  return matchesConstraints(scope.constraints, request.attributes, mode);
}

export function narrows(
  child: Scope,
  parent: Scope,
  options?: NarrowOptions
): boolean {
  if (child.action !== parent.action) {
    return false;
  }
  if (!targetNarrows(child.target, parent.target)) {
    return false;
  }
  if (!constraintsNarrow(child.constraints, parent.constraints)) {
    return false;
  }
  return digestNarrows(
    child.constraintsDigest,
    parent.constraintsDigest,
    options
  );
}

export function boundNarrows(
  child: ConstraintBound,
  parent: ConstraintBound
): boolean {
  if (child.op === "eq") {
    return matchesBound(parent, child.value, "allow");
  }
  if (child.op === "in") {
    return child.values.every((value) => matchesBound(parent, value, "allow"));
  }
  switch (parent.op) {
    case "eq":
      return (
        child.op === "range" &&
        typeof parent.value === "number" &&
        Number.isFinite(parent.value) &&
        child.min === parent.value &&
        child.max === parent.value
      );
    case "range":
      return child.op === "range" && narrowsRangeBounds(child, parent);
    case "prefix":
      return child.op === "prefix" && child.value.startsWith(parent.value);
    case "domainSuffix":
      return (
        child.op === "domainSuffix" &&
        narrowsDomainSuffix(child.value, parent.value)
      );
    case "commandPrefix":
      return (
        child.op === "commandPrefix" &&
        isValidCommandPrefix(parent.value) &&
        isValidCommandPrefix(child.value) &&
        matchesWordBoundedCommand(child.value, parent.value)
      );
    default:
      return false;
  }
}

function matchesBound(
  bound: ConstraintBound,
  value: JsonValue,
  mode: MatchMode = "allow"
): boolean {
  switch (bound.op) {
    case "eq":
      if (
        !isJsonPrimitive(value) ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        return mode === "restrictive";
      }
      if (
        mode === "restrictive" &&
        primitiveKind(value) !== primitiveKind(bound.value)
      ) {
        return true;
      }
      return value === bound.value;
    case "in":
      if (
        !isJsonPrimitive(value) ||
        (typeof value === "number" && !Number.isFinite(value))
      ) {
        return mode === "restrictive";
      }
      if (
        mode === "restrictive" &&
        bound.values.length > 0 &&
        !bound.values.some(
          (item) => primitiveKind(item) === primitiveKind(value)
        )
      ) {
        return true;
      }
      return bound.values.includes(value);
    case "range":
      return matchesRange(bound, value, mode);
    case "prefix":
      if (typeof value !== "string") {
        return mode === "restrictive";
      }
      return value.startsWith(bound.value);
    case "domainSuffix":
      return matchesDomainSuffix(bound.value, value, mode);
    case "commandPrefix":
      return matchesCommandPrefix(bound.value, value, mode);
    default:
      return false;
  }
}

function primitiveKind(value: JsonPrimitive): string {
  return value === null ? "null" : typeof value;
}

function isValidCommandPrefix(value: string): boolean {
  return (
    value.length > 0 &&
    !LEADING_WHITESPACE.test(value) &&
    !TRAILING_WHITESPACE.test(value) &&
    !DISALLOWED_COMMAND_SPACING.test(value) &&
    !SHELL_METACHARACTERS.test(value)
  );
}

export function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function matchesExactPrincipal(
  expected: Pick<Principal, "kind" | "id" | "version">,
  actual: Pick<Principal, "kind" | "id" | "version">,
  mode: MatchMode
): boolean {
  if (expected.kind !== actual.kind || expected.id !== actual.id) {
    return false;
  }
  if (expected.version === undefined) {
    return true;
  }
  if (actual.version === undefined) {
    return mode === "restrictive";
  }
  return actual.version === expected.version;
}

function matchesTarget(matcher: ScopeMatcher, target: string): boolean {
  switch (matcher.kind) {
    case "any":
      return true;
    case "exact":
      return target === matcher.value;
    case "prefix":
      return target.startsWith(matcher.value);
    case "in":
      return matcher.values.includes(target);
    default:
      return false;
  }
}

function targetNarrows(child: ScopeMatcher, parent: ScopeMatcher): boolean {
  if (parent.kind === "any") {
    return true;
  }
  if (child.kind === "any") {
    return false;
  }
  if (child.kind === "exact") {
    return matchesTarget(parent, child.value);
  }
  if (child.kind === "in") {
    return child.values.every((value) => matchesTarget(parent, value));
  }
  return parent.kind === "prefix" && child.value.startsWith(parent.value);
}

function matchesDigest(
  expected: string | undefined,
  actual: string | undefined,
  mode: MatchMode
): boolean {
  if (expected === undefined) {
    return true;
  }
  if (actual === undefined) {
    return mode === "restrictive";
  }
  return actual === expected;
}

function digestNarrows(
  childDigest: string | undefined,
  parentDigest: string | undefined,
  options?: NarrowOptions
): boolean {
  if (parentDigest === undefined) {
    return true;
  }
  if (childDigest === undefined) {
    return false;
  }
  if (childDigest === parentDigest) {
    return true;
  }
  return options?.isNarrowerDigest?.(parentDigest, childDigest) === true;
}

function matchesConstraints(
  constraints: Readonly<Record<string, ConstraintBound>> | undefined,
  attributes: Readonly<Record<string, JsonValue>> | undefined,
  mode: MatchMode
): boolean {
  if (constraints === undefined) {
    return true;
  }
  for (const [key, bound] of Object.entries(constraints)) {
    if (
      attributes === undefined ||
      !Object.hasOwn(attributes, key) ||
      attributes[key] === undefined
    ) {
      if (mode === "allow") {
        return false;
      }
      continue;
    }
    if (!matchesBound(bound, attributes[key], mode)) {
      return false;
    }
  }
  return true;
}

function constraintsNarrow(
  child: Readonly<Record<string, ConstraintBound>> | undefined,
  parent: Readonly<Record<string, ConstraintBound>> | undefined
): boolean {
  if (parent === undefined) {
    return true;
  }
  for (const [key, parentBound] of Object.entries(parent)) {
    if (child === undefined || !Object.hasOwn(child, key)) {
      return false;
    }
    const childBound = child[key];
    if (childBound === undefined || !boundNarrows(childBound, parentBound)) {
      return false;
    }
  }
  return true;
}

function matchesRange(
  bound: Extract<ConstraintBound, { readonly op: "range" }>,
  value: JsonValue,
  mode: MatchMode
): boolean {
  if (!isValidRangeBounds(bound.min, bound.max)) {
    return mode === "restrictive";
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return mode === "restrictive";
  }
  if (bound.min !== undefined && value < bound.min) {
    return false;
  }
  if (bound.max !== undefined && value > bound.max) {
    return false;
  }
  return true;
}

function isValidRangeBounds(
  min: number | undefined,
  max: number | undefined
): boolean {
  if (min !== undefined && !Number.isFinite(min)) {
    return false;
  }
  if (max !== undefined && !Number.isFinite(max)) {
    return false;
  }
  return !(min !== undefined && max !== undefined && min > max);
}

function narrowsRangeBounds(
  child: Extract<ConstraintBound, { readonly op: "range" }>,
  parent: Extract<ConstraintBound, { readonly op: "range" }>
): boolean {
  if (
    !(
      isValidRangeBounds(parent.min, parent.max) &&
      isValidRangeBounds(child.min, child.max)
    )
  ) {
    return false;
  }
  if (
    parent.min !== undefined &&
    (child.min === undefined || child.min < parent.min)
  ) {
    return false;
  }
  if (
    parent.max !== undefined &&
    (child.max === undefined || child.max > parent.max)
  ) {
    return false;
  }
  return true;
}

function normalizeDomain(value: string): string | null {
  if (value.length === 0 || INVALID_DOMAIN_CHARACTERS.test(value)) {
    return null;
  }
  const lowered = value.toLowerCase();
  if (lowered.includes("..") || lowered.endsWith(".")) {
    return null;
  }
  return lowered;
}

function matchesDomainSuffix(
  suffix: string,
  value: JsonValue,
  mode: MatchMode
): boolean {
  const normalizedSuffix = normalizeDomain(suffix);
  if (normalizedSuffix === null) {
    return mode === "restrictive";
  }
  if (typeof value !== "string") {
    return mode === "restrictive";
  }
  const normalizedHost = normalizeDomain(value);
  if (normalizedHost === null || normalizedHost.startsWith(".")) {
    return mode === "restrictive";
  }
  if (normalizedSuffix.startsWith(".")) {
    return normalizedHost.endsWith(normalizedSuffix);
  }
  return (
    normalizedHost === normalizedSuffix ||
    normalizedHost.endsWith(`.${normalizedSuffix}`)
  );
}

function narrowsDomainSuffix(
  childSuffix: string,
  parentSuffix: string
): boolean {
  const normalizedParent = normalizeDomain(parentSuffix);
  const normalizedChild = normalizeDomain(childSuffix);
  if (normalizedParent === null || normalizedChild === null) {
    return false;
  }
  if (normalizedParent.startsWith(".")) {
    return (
      normalizedChild === normalizedParent ||
      normalizedChild.endsWith(normalizedParent)
    );
  }
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.endsWith(`.${normalizedParent}`)
  );
}

function matchesWordBoundedCommand(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `);
}

function matchesCommandPrefix(
  prefix: string,
  value: JsonValue,
  mode: MatchMode
): boolean {
  if (typeof value !== "string") {
    return mode === "restrictive";
  }
  if (mode === "allow") {
    return (
      isValidCommandPrefix(prefix) &&
      isValidCommandPrefix(value) &&
      matchesWordBoundedCommand(value, prefix)
    );
  }
  const normalizedPrefix = prefix.trim().replace(COLLAPSIBLE_WHITESPACE, " ");
  if (normalizedPrefix.length === 0) {
    return true;
  }
  const segments = value.split(SHELL_SEGMENT_SEPARATOR);
  for (const segment of segments) {
    const normalized = segment.trim().replace(COLLAPSIBLE_WHITESPACE, " ");
    if (
      normalized.length > 0 &&
      matchesWordBoundedCommand(normalized, normalizedPrefix)
    ) {
      return true;
    }
  }
  return false;
}
