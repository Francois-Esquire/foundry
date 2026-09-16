import type {
  ExecutionPersistence,
  ExecutionRepository,
  RunJournal,
} from "@foundry/workflows/persistence";
import {
  createInMemoryExecutionPersistence,
  decodeRunFrame,
  decodeRunFrameSequence,
  decodeRunFrames,
} from "@foundry/workflows/persistence";
import { expect, test } from "vitest";

type PersistenceSubpathPins = [
  ExecutionPersistence,
  ExecutionRepository,
  RunJournal,
];

export type PersistenceConsumerTypePins = PersistenceSubpathPins;

test("persistence subpath exposes the complete consumer contract", () => {
  const persistence: ExecutionPersistence =
    createInMemoryExecutionPersistence();

  expect(persistence.repository).toBeDefined();
  expect(persistence.journal).toBeDefined();
  expect(typeof decodeRunFrame).toBe("function");
  expect(typeof decodeRunFrameSequence).toBe("function");
  expect(typeof decodeRunFrames).toBe("function");
});
