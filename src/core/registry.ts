import type { Provider } from 'ai';

import type { Adapter } from '../adapters/types';

export interface HealthStatus {
  healthy: boolean;
  issues?: Record<string, string>;
}

export interface ServiceRegistry {
  // Lock the registry for further modifications to internal components
  lock(): void;

  // Component Registration
  registerAdapter(name: string, adapter: Adapter): void;
  registerAgent(name: string, agent: Provider): void;

  // Service Registration
  registerService<T>(name: string, service: T): void;

  // Service Retrieval
  getAdapter(name: string): Adapter;
  getAgent(name: string): Provider;
  getService<T>(name: string): T;

  // Health Checks
  checkHealth(): Promise<HealthStatus>;
}

export class ServiceRegistryImpl implements ServiceRegistry {
  private internalKeys: Set<string> = new Set();
  private locked: boolean = false;

  private adapters: Map<string, Adapter> = new Map();
  private agents: Map<string, Provider> = new Map();
  private services: Map<string, any> = new Map();

  lock(): void {
    [
      ['adapters', ...this.adapters.keys()],
      ['agents', ...this.agents.keys()],
      ['services', ...this.services.keys()],
    ].forEach(([key, value]) => {
      this.internalKeys.add(`${key}:${value}`);
    });
    this.locked = true;
  }

  registerAdapter(name: string, adapter: Adapter): void {
    if (this.locked && this.internalKeys.has(`adapters:${name}`)) {
      throw new Error('Adapter already registered');
    }
    this.adapters.set(name, adapter);
  }

  registerAgent(name: string, agent: Provider): void {
    if (this.locked && this.internalKeys.has(`agents:${name}`)) {
      throw new Error('Agent already registered');
    }
    this.agents.set(name, agent);
  }

  registerService<T>(name: string, service: T): void {
    if (this.locked && this.internalKeys.has(`services:${name}`)) {
      throw new Error('Service already registered');
    }
    this.services.set(name, service);
  }

  getAdapter(name: string): Adapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Adapter not found: ${name}`);
    }
    return adapter;
  }

  getAgent(name: string): Provider {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Agent not found: ${name}`);
    }
    return agent;
  }

  getService<T>(name: string): T {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`Service not found: ${name}`);
    }
    return service as T;
  }

  async checkHealth(): Promise<HealthStatus> {
    const issues: Record<string, string> = {};
    let healthy = true;

    // Check adapter health
    for (const [name, adapter] of this.adapters.entries()) {
      try {
        // Basic health check - try to list root directory
        await adapter.list('/');
      } catch (error) {
        healthy = false;
        issues[`adapter:${name}`] = (error as Error).message;
      }
    }

    // Other health checks could be added here

    return {
      healthy,
      issues: Object.keys(issues).length > 0 ? issues : undefined,
    };
  }
}
