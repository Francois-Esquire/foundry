import type { Agent, AgentOptions } from './agent';

/**
 * Registry for managing agent instances.
 */
export class AgentRegistry {
  private agents: Map<string, Agent> = new Map();

  /**
   * Register an agent in the registry.
   */
  registerAgent(name: string, agent: Agent): void {
    this.agents.set(name, agent);
  }

  /**
   * Get an agent from the registry.
   * @throws Error if the agent is not found.
   */
  getAgent(name: string): Agent {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Agent not found: ${name}`);
    }
    return agent;
  }

  /**
   * Check if an agent exists in the registry.
   */
  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  /**
   * List all agent names in the registry.
   */
  getAgentNames(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get the count of registered agents.
   */
  getAgentCount(): number {
    return this.agents.size;
  }

  /**
   * Clear all agents from the registry.
   */
  clearAgents(): void {
    this.agents.clear();
  }

  /**
   * Configure an existing agent with new options.
   * @throws Error if the agent is not found.
   */
  async configureAgent(name: string, options: AgentOptions): Promise<void> {
    const agent = this.getAgent(name);
    await agent.configure(options);
  }
}
