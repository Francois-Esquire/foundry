import type { Agent } from '../agents/agent';
import type { Adapter } from '../adapters/types';

export interface HealthStatus {
  healthy: boolean;
  issues?: Record<string, string>;
}

export interface ServiceRegistry {
  // Component Registration
  registerAdapter(name: string, adapter: Adapter): void;
  registerAgent(name: string, agent: Agent): void;

  // Service Registration
  registerService<T>(name: string, service: T): void;

  // Service Retrieval
  getAdapter(name: string): Adapter;
  getAgent(name: string): Agent;
  getService<T>(name: string): T;

  // Health Checks
  checkHealth(): Promise<HealthStatus>;
}

export class ServiceRegistryImpl implements ServiceRegistry {
  private adapters: Map<string, Adapter> = new Map();
  private agents: Map<string, Agent> = new Map();
  private services: Map<string, any> = new Map();

  registerAdapter(name: string, adapter: Adapter): void {
    this.adapters.set(name, adapter);
  }

  registerAgent(name: string, agent: Agent): void {
    this.agents.set(name, agent);
  }

  registerService<T>(name: string, service: T): void {
    this.services.set(name, service);
  }

  getAdapter(name: string): Adapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Adapter not found: ${name}`);
    }
    return adapter;
  }

  getAgent(name: string): Agent {
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
