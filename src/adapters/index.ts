// Import the Adapter interface from core/types
import type { Adapter } from '../core/types';

// Import adapter implementations
import { FileSystemAdapter } from './fs';
import { InMemoryAdapter } from './in-memory';
import { JsonFileAdapter } from './json-file';
import { SQLiteAdapter } from './sqlite';

// Re-export the Adapter interface
export type { Adapter };

// Re-export adapter implementations
export { FileSystemAdapter, InMemoryAdapter, JsonFileAdapter, SQLiteAdapter };
