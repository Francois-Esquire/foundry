import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MODULE_SDK_EMITTED } from "../../sdk/emitted";

/** The emitted SDK's exports these tests use, as a Program or View sees them. */
export interface ModuleSdk {
  createGatewayClient(transport: unknown): GatewayClient;
  createProgramGateway(): ProgramGateway;
  createWebSocketGatewayTransport(socket: unknown): unknown;
  readonly GatewayFailure: new (code: string, message: string) => Error;
  isModuleTheme(value: unknown): boolean;
  relayModuleTheme(
    gateway: { readonly client: GatewayClient | undefined },
    request: Request,
    alias?: string
  ): Promise<Response>;
  watchModuleTheme(
    onTheme: (theme: ModuleTheme | null) => void,
    options?: { signal?: AbortSignal; url?: string; retryMs?: number }
  ): Promise<void>;
}

export interface GatewayClient {
  call(
    alias: string,
    input: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
  observe(
    alias: string,
    input: unknown,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<unknown>;
}

export interface ProgramSocket {
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  send(data: string): unknown;
}

export interface ProgramGateway {
  readonly client: GatewayClient | undefined;
  readonly websocket: {
    open(socket: ProgramSocket): void;
    message(socket: ProgramSocket, message: unknown): void;
    close(socket: ProgramSocket): void;
  };
}

export interface ModuleTheme {
  readonly effective: "light" | "dark";
  readonly mode: "auto" | "light" | "dark";
  readonly revision: number;
}

let loaded: Promise<ModuleSdk> | undefined;

/** Imports the SDK's emitted ESM, the exact `dist/index.js` a workspace receives. */
export function importModuleSdk(): Promise<ModuleSdk> {
  loaded ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "module-sdk-"));
    const file = path.join(directory, "index.mjs");
    await writeFile(file, MODULE_SDK_EMITTED.esm);
    return (await import(pathToFileURL(file).href)) as ModuleSdk;
  })();
  return loaded;
}
