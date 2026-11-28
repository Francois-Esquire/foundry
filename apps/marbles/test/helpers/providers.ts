import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gc } from "bun";
import { initializeDatabase } from "~/database/open";
import { DatabaseProviderStore } from "~/database/providers";
import { stateDatabase } from "~/layout";
import { fakeClaude } from "./claude";
import { fakeCodex } from "./codex";

const TEST_PROVIDERS = ["claude-code", "codex", "pi"] as const;

export const PROVIDERS_TEMPLATE_ENV = "MARBLES_TEST_PROVIDERS_DB";

export async function makeProvidersTemplate(
  dir: string,
  ids: readonly string[] = TEST_PROVIDERS
): Promise<string> {
  const file = join(dir, "providers-template.db");
  const bins = new Map<string, string>();
  if (ids.includes("claude-code")) {
    bins.set("claude-code", fakeClaude(dir));
  }
  if (ids.includes("codex")) {
    bins.set("codex", fakeCodex(dir));
  }
  const opened = await initializeDatabase(file);
  try {
    await new DatabaseProviderStore({ database: opened.database }).update(
      undefined,
      () => ({
        machine: {
          providers: ids.map((id) => {
            const binPath = bins.get(id);
            return {
              enabled: true,
              id,
              plugin: id,
              ...(binPath ? { settings: { binPath } } : {}),
            };
          }),
          version: 1,
        },
      })
    );
  } finally {
    opened.close();
  }
  for (let attempt = 0; existsSync(`${file}-wal`); attempt += 1) {
    if (attempt === 100) {
      throw new Error(`the template database at ${file} kept its WAL file`);
    }
    gc(true);
    await new Promise((settle) => setTimeout(settle, 50));
  }
  return file;
}

export function configureProviders(
  state: string,
  template = process.env[PROVIDERS_TEMPLATE_ENV]
): void {
  if (template === undefined || !existsSync(template)) {
    throw new Error("configureProviders runs inside the suite's setup only");
  }
  mkdirSync(state, { recursive: true });
  copyFileSync(template, stateDatabase(state));
}
