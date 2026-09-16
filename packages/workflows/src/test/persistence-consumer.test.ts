import { expect, test } from "vitest";

import type { ExecutionRepository } from "../execution-repository";
import type { ExecutionPersistence } from "../persistence";
import { createInMemoryExecutionPersistence } from "../persistence";
import type { RunJournal } from "../run-journal";
import {
  decodeRunFrame,
  decodeRunFrameSequence,
  decodeRunFrames,
} from "../run-journal";

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
