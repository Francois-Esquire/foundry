import {
  isPortableRelativePath,
  MIME_TYPE_PATTERN,
} from "@foundry/modules/manifest";
import { MODULE_SETTING_HOST_POLICY } from "@foundry/modules/settings";
import { z } from "zod";
import {
  constrained,
  described,
  fields,
  input,
  integer,
  noConstraints,
  object,
  optional,
  portable,
  required,
  text,
} from "~/main/gateway/provider-kit";
import { ARTIFACT_CAPABILITIES } from "./host";

/**
 * What Programs see of the Artifact capabilities: each input as declared
 * once (validator and description), the output and event descriptions, and
 * the constraint policies.
 */

/** The host ceiling on one written file: the `artifacts.maxFileBytes` ceiling. */
export const FILE_MAX_BYTES =
  MODULE_SETTING_HOST_POLICY["artifacts.maxFileBytes"].ceiling;

/** Binding-only operations take no constraints: one fixed digest each. */
export const bindingOnly = (capability: string) =>
  noConstraints(
    capability,
    "binding-only",
    `${capability} works on bindings only; it takes no constraints`
  );

const createConstraints = z
  .object({
    maxBytes: z.number().int().positive().max(FILE_MAX_BYTES),
    mimeTypes: z.array(z.string().regex(MIME_TYPE_PATTERN)).min(1).max(32),
  })
  .strict();

/** The MIME types a Module may create and their decoded size limit. */
export const createPolicy = constrained(ARTIFACT_CAPABILITIES.create, (raw) => {
  const parsed = createConstraints.parse(raw);
  return {
    maxBytes: parsed.maxBytes,
    mimeTypes: [...new Set(parsed.mimeTypes)].sort(),
  };
});

// ── Shared fields ──

const bindingDescription = text(
  "The editor binding the host opened this app with."
);
const bindingId = z.string().min(1);
const entry = object(
  {
    bytes: integer("Size in bytes."),
    digest: text("SHA-256 of the saved bytes; the save fence."),
    mime: described("MIME type, or null."),
    path: text("Path within the Artifact."),
  },
  ["bytes", "digest", "mime", "path"]
);
const artifactIdField = optional(
  z.string().min(1).max(200),
  text("An Artifact your approved broader scope covers (instead of a binding).")
);
const pathField = optional(
  z.string().min(1).max(512),
  text(
    "With artifactId: the entry to use; the Artifact's primary entry when omitted."
  )
);
const retried = portable({
  description: "Answered from an earlier commit of this request.",
  type: "boolean",
});

/** A bound entry, or (under the broader scope) an Artifact's entry by id. */
function oneTarget(target: {
  readonly artifactId?: string;
  readonly binding?: string;
  readonly path?: string;
}): boolean {
  return target.binding === undefined
    ? target.artifactId !== undefined
    : target.artifactId === undefined && target.path === undefined;
}

const TARGET_MESSAGE = "Name either a binding, or an artifactId (and path)";

// ── works.editors.binding ──

export const bindingInput = fields({
  binding: required(bindingId, bindingDescription),
  refresh: optional(
    z.boolean(),
    portable({
      description: "Move the binding to the Artifact's active Content.",
      type: "boolean",
    })
  ),
});

export const bindingOutput = object(
  {
    artifactId: text("The Artifact."),
    binding: bindingDescription,
    contentId: text("The Content the binding reads and saves."),
    entry,
    mode: portable({ enum: ["read", "write"], type: "string" }),
    name: text("The Artifact's name."),
    updatedAt: text("When the Content last changed (ISO 8601)."),
  },
  ["artifactId", "binding", "contentId", "entry", "mode", "name", "updatedAt"]
);

// ── works.artifacts.read ──

const readFields = fields({
  artifactId: artifactIdField,
  binding: optional(bindingId, bindingDescription),
  offset: optional(
    z.number().int().nonnegative(),
    integer("Byte offset to read from; 0 when omitted.")
  ),
  path: pathField,
});

export const readInput = input(
  readFields.schema.refine(oneTarget, TARGET_MESSAGE),
  readFields.description
);

export const readOutput = object(
  {
    bytes: integer("Size of the whole entry."),
    data: text("This chunk, base64."),
    digest: text(
      "SHA-256 of the whole entry; if it changes between chunks, start over."
    ),
    mime: described("MIME type, or null."),
    next: described("Offset of the next chunk, or null after the last."),
    offset: integer("Where this chunk starts."),
  },
  ["bytes", "data", "digest", "mime", "next", "offset"]
);

// ── works.artifacts.save ──

export const saveInput = fields({
  binding: required(bindingId, bindingDescription),
  expectedDigest: required(
    z.string().min(1),
    text("Digest of the entry your edits started from.")
  ),
  request: required(
    z.string().min(1).max(200),
    text("Your id for this change (at most 200 characters).")
  ),
  retry: optional(
    z.boolean(),
    portable({
      description: "This request was sent before and its answer was lost.",
      type: "boolean",
    })
  ),
  text: required(z.string(), text("The entry's complete new text.")),
});

export const saveOutput = object(
  {
    bytes: integer("Size of the saved entry."),
    current: object(
      {
        bytes: integer("Size of the saved entry."),
        digest: text("Its digest: the fence for the next save."),
        text: text("Its text."),
      },
      ["bytes", "digest", "text"],
      "On conflict: the saved entry, which your edits did not replace."
    ),
    digest: text("Digest of the saved entry: the fence for the next save."),
    evidence: portable({
      description:
        "recovery-required: saved, but the host could not record it yet; the next save waits for that.",
      enum: ["recorded", "recovery-required"],
      type: "string",
    }),
    kind: portable({
      enum: [
        "saved",
        "conflict",
        "stale",
        "denied",
        "refused",
        "uncertain",
        "failed",
      ],
      type: "string",
    }),
    reason: text("Why nothing was saved."),
    retried,
    updatedAt: text("When the Content changed (ISO 8601)."),
  },
  ["kind"]
);

// ── works.artifacts.create ──

export const createInput = fields({
  content: required(z.string(), text("The entry's content.")),
  encoding: optional(
    z.enum(["utf8", "base64"]),
    portable({
      description: "How `content` is encoded; utf8 when omitted.",
      enum: ["utf8", "base64"],
      type: "string",
    })
  ),
  mime: required(
    z.string().regex(MIME_TYPE_PATTERN),
    text("The entry's MIME type, which is also the Artifact type.")
  ),
  name: required(
    z.string().trim().min(1).max(200),
    text("The Artifact's name.")
  ),
  path: required(
    z.string().min(1).max(512).refine(isPortableRelativePath),
    text("The entry's path, such as notes.md.")
  ),
  request: required(
    z.string().min(1).max(200),
    text("Your id for this creation; resending it returns the same file.")
  ),
});

export const createOutput = object(
  {
    artifactId: text("The new File Artifact."),
    binding: bindingDescription,
    bytes: integer("Size of the entry."),
    contentId: text("Its Content."),
    digest: text("Digest of the entry: the fence for the first save."),
    mode: portable({ enum: ["write"], type: "string" }),
    path: text("The primary entry."),
    retried,
    updatedAt: text("When the Content was written (ISO 8601)."),
  },
  [
    "artifactId",
    "binding",
    "bytes",
    "contentId",
    "digest",
    "mode",
    "path",
    "retried",
    "updatedAt",
  ]
);

// ── works.artifacts.watch ──

const afterFields = fields(
  {
    contentId: required(z.string().min(1), text("The Content you last saw.")),
    digest: required(z.string().min(1), text("The entry digest you last saw.")),
  },
  "The state you saw before reconnecting."
);

const watchFields = fields({
  after: optional(afterFields.schema, afterFields.description),
  artifactId: artifactIdField,
  binding: optional(bindingId, bindingDescription),
  path: pathField,
});

export const watchInput = input(
  watchFields.schema.refine(oneTarget, TARGET_MESSAGE),
  watchFields.description
);

export const watchEvent = object(
  {
    artifactId: text("The Artifact."),
    contentId: described("Its active Content, or null once removed."),
    entry: described("The watched entry's saved state, or null once removed."),
    gap: portable({
      description:
        "On a snapshot: the entry changed since `after`, and those changes are not replayed.",
      type: "boolean",
    }),
    kind: portable({ enum: ["snapshot", "change", "removed"], type: "string" }),
    updatedAt: described("When the Content last changed (ISO 8601)."),
  },
  ["artifactId", "contentId", "entry", "kind", "updatedAt"]
);

// ── works.artifacts.list ──

export const listInput = fields({
  cursor: optional(
    z.string().min(1).max(1000),
    text("Where the previous page ended (its `next`).")
  ),
});

export const listOutput = object(
  {
    items: portable({
      description:
        "Artifacts in scope, oldest first: `{ artifactId, contentId, entry, name, type, updatedAt }`, where `entry` is the primary entry (`{ bytes, digest, mime, path }`) or null.",
      items: portable({ type: "object" }),
      type: "array",
    }),
    next: described("Pass as `cursor` for the next page; null at the end."),
  },
  ["items", "next"]
);
