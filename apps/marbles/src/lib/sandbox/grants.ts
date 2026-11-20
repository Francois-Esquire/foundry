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

const FORMAT = "agent-grants/1";

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
