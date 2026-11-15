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
import type { GrantDocumentStorage } from "@foundry/lib/config/authorization/document";
import { DocumentGrantRepository } from "@foundry/lib/config/authorization/document";

/** The document's format tag: one written by another host or version is refused. */
const FORMAT = "agent-grants/1";

/**
 * Private durable host authority: a workspace's agent grants, one
 * document wherever `storage` keeps it (the Marbles database's, for a
 * host), with the reference repository semantics. A document that does
 * not validate fails closed.
 */
export class StoredAgentGrantRepository
  extends DocumentGrantRepository<AgentSubject, Capability>
  implements AgentGrantRepository
{
  constructor(
    storage: GrantDocumentStorage,
    options: { readonly now?: () => number } = {}
  ) {
    super({
      addressing: agentAddressing,
      capability: capabilitySchema,
      format: FORMAT,
      storage,
      subject: agentSubjectSchema,
      ...(options.now ? { now: options.now } : {}),
    });
  }
}
