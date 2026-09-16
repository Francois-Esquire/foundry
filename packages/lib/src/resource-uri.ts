const HEX_BYTES_PATTERN = /^(?:[0-9a-f]{2})+$/;

/**
 * Scheme-agnostic resource URI construction and parsing. Resource identity
 * lives in the host: `<scheme>://<id>.<resource>/<path>`. The scheme itself is
 * the caller's — apps bind their own (and its meaning) in a local wrapper.
 */

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;
const RESOURCE_PATTERN = /^[a-z][a-z0-9-]*$/;
const DIRECT_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const ENCODED_ID_PREFIX = "id-";
const ENCODED_ID_LABEL_LENGTH = 60;

export interface ResourceAddress {
  readonly id: string;
  /** Decoded path relative to the addressed resource. */
  readonly path: string;
  readonly resource: string;
}

export class ResourceUriError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`[resource-uri] ${message}`, options);
    this.name = new.target.name;
  }
}

/**
 * Constructs `<scheme>://<id>.<resource>/<path>` through the platform URL API.
 * IDs must survive hostname normalization exactly; callers never hand-build a
 * resource URI or guess how an opaque domain identity maps into an origin.
 */
export function createResourceUrl(input: {
  readonly scheme: string;
  readonly resource: string;
  readonly id: string;
  readonly path?: string;
}): URL {
  requireScheme(input.scheme);
  requireResource(input.resource);
  if (input.id.length === 0) {
    throw new ResourceUriError("id must not be empty");
  }

  const url = new URL(`${input.scheme}://placeholder.${input.resource}/`);
  url.hostname = `${authorityId(input.id)}.${input.resource}`;
  const parsed = parseResourceUrl(input.scheme, url);
  if (parsed?.resource !== input.resource || parsed.id !== input.id) {
    throw new ResourceUriError(
      `id ${JSON.stringify(input.id)} is not a canonical URL hostname identity`
    );
  }
  url.pathname = formatResourcePath(input.path ?? "");
  return url;
}

export function formatResourceUrl(input: {
  readonly scheme: string;
  readonly resource: string;
  readonly id: string;
  readonly path?: string;
}): string {
  return createResourceUrl(input).toString();
}

/** Uses URL for scheme, authority, query, fragment, and path parsing. */
export function parseResourceUrl(
  scheme: string,
  input: string | URL
): ResourceAddress | null {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${scheme}:` ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return null;
  }

  const boundary = url.hostname.lastIndexOf(".");
  if (boundary <= 0 || boundary === url.hostname.length - 1) {
    return null;
  }
  const authority = url.hostname.slice(0, boundary);
  const resource = url.hostname.slice(boundary + 1);
  if (!RESOURCE_PATTERN.test(resource)) {
    return null;
  }

  const id = domainId(authority);
  const path = parseResourcePath(url.pathname);
  return id === null || path === null
    ? null
    : Object.freeze({ id, path, resource });
}

/**
 * Decode one URL pathname into the relative resource path consumers use.
 * Separators are structural: an encoded slash/backslash, dot segment, NUL, or
 * malformed escape is rejected rather than being materialized after the URL
 * parser's own normalization pass.
 */
export function parseResourcePath(pathname: string): string | null {
  if (!pathname.startsWith("/")) {
    return null;
  }
  if (pathname === "/") {
    return "";
  }

  const segments = pathname.slice(1).split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return null;
  }
  try {
    const decoded = segments.map((segment) => decodeURIComponent(segment));
    if (decoded.some(invalidPathSegment)) {
      return null;
    }
    return decoded.join("/");
  } catch {
    return null;
  }
}

function requireScheme(scheme: string): void {
  if (!SCHEME_PATTERN.test(scheme)) {
    throw new ResourceUriError(
      `scheme ${JSON.stringify(scheme)} must be a lower-case URI scheme`
    );
  }
}

function requireResource(resource: string): void {
  if (!RESOURCE_PATTERN.test(resource)) {
    throw new ResourceUriError(
      `resource ${JSON.stringify(resource)} must be a lower-case identifier`
    );
  }
}

function formatResourcePath(path: string): string {
  if (path.length === 0) {
    return "/";
  }
  if (path.startsWith("/") || path.endsWith("/")) {
    throw new ResourceUriError("path must be relative and name a resource");
  }
  const segments = path.split("/");
  if (segments.some(invalidPathSegment)) {
    throw new ResourceUriError(
      `path ${JSON.stringify(path)} contains an unsafe segment`
    );
  }
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function invalidPathSegment(segment: string): boolean {
  return (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  );
}

function authorityId(id: string): string {
  if (DIRECT_ID_PATTERN.test(id) && !id.startsWith(ENCODED_ID_PREFIX)) {
    return id;
  }
  const encoded = [...new TextEncoder().encode(id)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const labels: string[] = [];
  for (
    let offset = 0;
    offset < encoded.length;
    offset += ENCODED_ID_LABEL_LENGTH
  ) {
    labels.push(encoded.slice(offset, offset + ENCODED_ID_LABEL_LENGTH));
  }
  labels[0] = `${ENCODED_ID_PREFIX}${labels[0]}`;
  return labels.join(".");
}

function domainId(authority: string): string | null {
  if (!authority.startsWith(ENCODED_ID_PREFIX)) {
    return DIRECT_ID_PATTERN.test(authority) ? authority : null;
  }
  const encoded = authority.slice(ENCODED_ID_PREFIX.length).replaceAll(".", "");
  if (!HEX_BYTES_PATTERN.test(encoded)) {
    return null;
  }
  const bytes = new Uint8Array(
    encoded.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
