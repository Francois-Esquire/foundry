import type {
  AgentGrantRepository,
  AgentSubject,
  Capability,
} from "@foundry/agents/authorization";
import {
  agentAddressing,
  agentSubjectSchema,
  capabilitySchema,
} from "@foundry/agents/authorization";
import { FileGrantRepository } from "@foundry/lib/config/authorization/file";

/** The on-disk format tag; files written before the move to `FileGrantRepository` carry it too. */
const FORMAT = "agent-grants/1";

/**
 * Private durable host authority: agent grants in one JSON file, with the
 * reference repository semantics. An abandoned writer lock fails closed.
 */
export class JsonAgentGrantRepository
  extends FileGrantRepository<AgentSubject, Capability>
  implements AgentGrantRepository
{
  constructor(path: string, options: { readonly now?: () => number } = {}) {
    super({
      addressing: agentAddressing,
      capability: capabilitySchema,
      format: FORMAT,
      path,
      subject: agentSubjectSchema,
      ...(options.now ? { now: options.now } : {}),
    });
  }
}
