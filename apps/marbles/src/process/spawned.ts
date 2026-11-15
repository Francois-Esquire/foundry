/**
 * The background-process records Marbles writes where `MARBLES_SPAWN_RECORD`
 * points: the daemon a client starts, each worker the daemon starts, the
 * server `marbles mcp` relays, and what its steps and agents start. The
 * recorder and its contract are `@foundry/lib/spawn-record`, which the
 * packages Marbles uses share.
 */
// biome-ignore lint/performance/noBarrelFile: the one name Marbles and its tests give the shared recorder, kept so the tiers above `lib/` import it from `process/`.
export {
  notPrivate,
  recordSpawned,
  SPAWN_OWNER_ENV,
  SPAWN_RECORD_ENV,
  SPAWN_RECOVERY_ENV,
  type SpawnRecord,
  startedAt,
  writePrivate,
} from "@foundry/lib/spawn-record";
