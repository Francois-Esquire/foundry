// biome-ignore lint/performance/noBarrelFile: the one name Marbles and its tests give the shared recorder and its start-time proof, kept so the tiers above `lib/` import them from `process/`.
export { nodeStartedAt as startedAt } from "@foundry/lib/node/process-identity";
export {
  configureSpawnRecovery,
  notPrivate,
  recordSpawned,
  SPAWN_OWNER_ENV,
  SPAWN_RECORD_ENV,
  type SpawnRecord,
  writePrivate,
} from "@foundry/lib/node/spawn-record";
