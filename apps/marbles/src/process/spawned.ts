/**
 * The background-process records Marbles writes where `MARBLES_SPAWN_RECORD`
 * points: the daemon a client starts, each worker the daemon starts, the
 * server `marbles mcp` relays, and what its steps and agents start. The
 * recorder and its contract are `@foundry/lib/spawn-record`, which the
 * packages Marbles uses share.
 */
// biome-ignore lint/performance/noBarrelFile: the one name Marbles and its tests give the shared recorder, kept so the tiers above `lib/` import it from `process/`.

// biome-ignore lint/performance/noBarrelFile: as above, the recorder's start-time proof under the same name.
export { startedAt } from "@foundry/lib/process-identity";
export {
  notPrivate,
  recordSpawned,
  SPAWN_OWNER_ENV,
  SPAWN_RECORD_ENV,
  SPAWN_RECOVERY_ENV,
  type SpawnRecord,
  writePrivate,
} from "@foundry/lib/spawn-record";
