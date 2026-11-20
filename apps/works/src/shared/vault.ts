export type VaultGroup = "provider" | "integration";

export type VaultFieldKind = "secret" | "url" | "text";

type VaultTier = "secure" | "settings";

export type FieldSource = "store" | "env" | "default" | "none";

export interface FieldState {
  isSet: boolean;
  source: FieldSource;
}

export interface VaultField {
  envVar?: string;
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

export function vaultStoreKey(ownerId: VaultOwnerId, key: string): string {
  return `${ownerId}:${key}`;
}

export interface VaultStatus {
  encryption: "available" | "unavailable";
  fields: Record<VaultOwnerId, Record<string, FieldState>>;
}
