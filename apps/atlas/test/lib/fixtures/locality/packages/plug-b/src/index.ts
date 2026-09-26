import type { Plugin, Token } from "@l/core";

export class PluginB implements Plugin {
  run(): number {
    return 2;
  }
  stop(): void {
    return;
  }
}

export interface PlugBTokenBox {
  token: Token;
}
