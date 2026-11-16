// biome-ignore lint/performance/noBarrelFile: the one name Marbles and its tests give the shared recorder and its start-time proof, kept so the tiers above `lib/` import them from `process/`.
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
