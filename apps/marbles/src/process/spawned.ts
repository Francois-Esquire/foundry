// biome-ignore lint/performance/noBarrelFile: the one name Marbles and its tests give the shared recorder, kept so the tiers above `lib/` import it from `process/`.
export {
  notPrivate,
  recordSpawned,
  SPAWN_OWNER_ENV,
  SPAWN_RECORD_ENV,
  type SpawnRecord,
  startedAt,
  writePrivate,
} from "@foundry/lib/spawn-record";
