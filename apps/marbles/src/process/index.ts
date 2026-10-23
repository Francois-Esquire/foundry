/**
 * The process entry, `@foundry.sh/marbles/process`: what makes a program
 * that holds an `Engine` the one Marbles process for its workspace, and
 * keeps that engine's triggers running. A host builds the engine (its own,
 * or through the CLI's defaults), claims the workspace, starts the engine,
 * and runs the loop until it is told to stop:
 *
 *     const claim = claimProcess(stateDir, { config, host: "headless" });
 *     try {
 *       await engine.start();
 *       await runSchedulesUntilStopped(engine, { signal });
 *     } finally {
 *       await engine.stop();
 *       claim.release();
 *     }
 *
 * It imports only the engine layer: no CLI, no source discovery, no views.
 */

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for programmatic hosts.
export {
  claimProcess,
  ProcessHeldError,
  type ProcessHost,
  type ProcessInfo,
  type ProcessInstance,
  type ProcessStatus,
  readProcess,
} from "./instance";
