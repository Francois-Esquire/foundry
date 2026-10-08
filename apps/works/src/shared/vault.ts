/**
 * The vault registry: every credential Works can hold, declared once and read
 * by both processes. The main process uses the storage tier and environment
 * variable of each field; the renderer uses the labels, kinds, and docs links.
 * Adding a credential is one entry here.
 */

export type VaultGroup = "provider" | "integration";

export type VaultFieldKind = "secret" | "url" | "text";

/** Secrets are encrypted at rest; settings are plain text. */
type VaultTier = "secure" | "settings";

/**
 * Where a field's current value comes from.
 * - store: the user set it and it is persisted on this device.
 * - env: an environment variable supplies it.
 * - default: a built-in fallback, such as a localhost gateway URL.
 * - none: unset.
 */
export type FieldSource = "store" | "env" | "default" | "none";

/** Live state of one field. Never carries the value itself. */
export interface FieldState {
  isSet: boolean;
  source: FieldSource;
}

export interface VaultField {
  /** Environment variable consulted when nothing is stored. */
  envVar?: string;
  /** Built-in value used when neither the store nor the environment has one. */
  fallback?: string;
  key: string;
  kind: VaultFieldKind;
  label: string;
  placeholder?: string;
  tier: VaultTier;
}

export const VAULT_OWNER_IDS = [
  "gateway",
  "claude",
  "vercel",
  "fal",
  "replicate",
  "googleStitch",
] as const;

export type VaultOwnerId = (typeof VAULT_OWNER_IDS)[number];

/** A service that owns one or more credential fields. */
export interface VaultOwner {
  docsUrl?: string;
  fields: readonly VaultField[];
  group: VaultGroup;
  id: VaultOwnerId;
  label: string;
}

const API_KEY = {
  key: "apiKey",
  kind: "secret",
  label: "API Key",
  tier: "secure",
} as const satisfies Partial<VaultField>;

export const VAULT_OWNERS: readonly VaultOwner[] = [
  {
    docsUrl: "https://docs.litellm.ai",
    fields: [
      { ...API_KEY, envVar: "LITELLM_PROXY_API_KEY", placeholder: "sk-…" },
      {
        envVar: "LITELLM_PROXY_HOST_URL",
        fallback: "http://localhost:4000",
        key: "baseURL",
        kind: "url",
        label: "Proxy URL",
        placeholder: "http://localhost:4000",
        tier: "settings",
      },
    ],
    group: "provider",
    id: "gateway",
    label: "Gateway",
  },
  {
    docsUrl: "https://console.anthropic.com/settings/keys",
    fields: [
      { ...API_KEY, envVar: "ANTHROPIC_API_KEY", placeholder: "sk-ant-…" },
      {
        envVar: "ANTHROPIC_BASE_URL",
        key: "baseURL",
        kind: "url",
        label: "Base URL",
        placeholder: "https://api.anthropic.com",
        tier: "settings",
      },
    ],
    group: "provider",
    id: "claude",
    label: "Claude",
  },
  {
    docsUrl: "https://vercel.com/docs/ai-gateway",
    fields: [
      { ...API_KEY, envVar: "AI_GATEWAY_API_KEY", placeholder: "vck_…" },
    ],
    group: "provider",
    id: "vercel",
    label: "Vercel",
  },
  {
    docsUrl: "https://fal.ai/dashboard/keys",
    fields: [{ ...API_KEY, envVar: "FAL_KEY", placeholder: "fal_…" }],
    group: "provider",
    id: "fal",
    label: "FAL",
  },
  {
    docsUrl: "https://replicate.com/account/api-tokens",
    fields: [
      {
        ...API_KEY,
        envVar: "REPLICATE_API_TOKEN",
        label: "API Token",
        placeholder: "r8_…",
      },
    ],
    group: "provider",
    id: "replicate",
    label: "Replicate",
  },
  {
    docsUrl: "https://stitch.withgoogle.com/docs/sdk/ai-sdk/",
    // The Stitch SDK reads STITCH_API_KEY itself when no key is passed, so
    // the status agrees with what the tool would actually use.
    fields: [{ ...API_KEY, envVar: "STITCH_API_KEY", placeholder: "stitch-…" }],
    group: "integration",
    id: "googleStitch",
    label: "Google Stitch",
  },
];

export function vaultOwnersIn(group: VaultGroup): readonly VaultOwner[] {
  return VAULT_OWNERS.filter((owner) => owner.group === group);
}

export function findVaultField(
  ownerId: string,
  key: string
): { field: VaultField; owner: VaultOwner } | undefined {
  const owner = VAULT_OWNERS.find((candidate) => candidate.id === ownerId);
  const field = owner?.fields.find((candidate) => candidate.key === key);
  return owner && field ? { field, owner } : undefined;
}

/** Key a field is stored under in its tier. */
export function vaultStoreKey(ownerId: VaultOwnerId, key: string): string {
  return `${ownerId}:${key}`;
}

/** Per-owner, per-field state, plus whether secrets can be read at all. */
export interface VaultStatus {
  /** False when the OS keychain is unavailable, so secrets cannot be read. */
  encryption: "available" | "unavailable";
  fields: Record<VaultOwnerId, Record<string, FieldState>>;
}
