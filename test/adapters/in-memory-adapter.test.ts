import { InMemoryAdapter } from '../../src/adapters/in-memory';
import { createAdapterTests } from './adapter-test-suite';

// Create the test suite for InMemoryAdapter
createAdapterTests(
  'InMemory',
  () => new InMemoryAdapter()
  // No cleanup needed for InMemoryAdapter
);
