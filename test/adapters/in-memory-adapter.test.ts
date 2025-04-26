import { InMemoryAdapter } from '../../src/adapters';
import { createAdapterTests } from './adapter-test-suite';

// Create the test suite for InMemoryAdapter
createAdapterTests(
  'InMemory',
  () => new InMemoryAdapter()
  // No cleanup needed for InMemoryAdapter
);
