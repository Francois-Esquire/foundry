/**
 * Compatibility entry point for existing Orchestrator consumers.
 *
 * New persistence implementations should use the repository, journal, and
 * persistence seams rather than treating this barrel as one indivisible store.
 */
export * from "./execution-coordinator";
export { InMemoryOrchestratorStore } from "./in-memory-execution-persistence";
