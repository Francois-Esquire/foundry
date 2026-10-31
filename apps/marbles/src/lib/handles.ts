/**
 * Where a declared sandbox keeps the function that starts it, so a manager
 * handed the definition itself (`agents.session(def, { sandbox: box })`)
 * can start it the way its own `exec` would. A symbol, so it is never a
 * field of the definition's data.
 */
export const SANDBOX_HANDLE = Symbol("marbles.sandbox.handle");

/**
 * Where an agent declared with a function keeps what builds its
 * definition, given the route a session must keep. The session manager
 * calls it as the session opens. A symbol, so a spread of the agent is
 * never mistaken for a definition.
 */
export const AGENT_DEFINITION = Symbol("marbles.agent.definition");
