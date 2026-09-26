import type { Plugin, Token } from "@l/core";

export class PluginA implements Plugin {
  run(): number {
    return 1;
  }
  stop(): void {
    return;
  }
}

export interface PlugATokenBox {
  token: Token;
}
