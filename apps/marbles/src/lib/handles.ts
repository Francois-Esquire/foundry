/**
 * Where a declared sandbox keeps the function that starts it, so a manager
 * handed the definition itself (`agents.session(def, { sandbox: box })`)
 * can start it the way its own `exec` would. A symbol, so it is never a
 * field of the definition's data.
 */
export const SANDBOX_HANDLE = Symbol("marbles.sandbox.handle");
