# Foundry Adapters Specification

This document outlines the architecture and implementation details for Foundry's adapter system.

## Overview

Adapters in Foundry provide a uniform interface to persistence layers. They abstract away the specifics of various storage systems, allowing the Core Library to interact with different persistence mechanisms in a consistent way.

```
┌─────────────────┐     ┌─────────────────┐     ┌───────────────────┐
│                 │     │                 │     │                   │
│  Core Library   │◄───►│     Adapter     │◄───►│ Persistence Layer │
│                 │     │                 │     │                   │
└─────────────────┘     └─────────────────┘     └───────────────────┘
```

## Core Adapter Interface

All adapters must implement the following core methods:

### Public Methods

```typescript
interface Adapter {
  // Basic Operations
  read(path: string): Promise<{ content: string; type: string } | null>;
  write(path: string, content: string, type: string): Promise<boolean>;
  delete(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;

  // Directory Operations
  list(path: string): Promise<string[]>;
  createDirectory(path: string): Promise<boolean>;
  deleteDirectory(path: string, recursive?: boolean): Promise<boolean>;

  // Metadata Operations
  getMetadata(path: string): Promise<Record<string, any> | null>;
  setMetadata(path: string, metadata: Record<string, any>): Promise<boolean>;

  // Utility Operations
  move(sourcePath: string, destinationPath: string): Promise<boolean>;
  copy(sourcePath: string, destinationPath: string): Promise<boolean>;
}
```

### Transform Interface

All adapters expose a transform interface for operation interception:

```typescript
interface AdapterTransform {
  beforeOperation(operation: string, params: any): Promise<any>;
  afterOperation(operation: string, result: any): Promise<any>;
  onError(operation: string, error: Error): Promise<any>;
}
```

## Key Concepts

### Path

A string that uniquely identifies a resource within the persistence layer. Paths follow a hierarchical structure similar to file system paths:

- `/` represents the root
- `/directory/file.txt` represents a file in a directory
- Paths may or may not correspond to actual files depending on the adapter

### Content

The raw data stored at a particular path. Content is typically stored as strings but may be converted to or from other formats (e.g., JSON, binary) by the adapter as needed.

### Type

A string identifier for the kind of content stored at a path. This helps the Core Library and other components understand how to process the content. Examples include:

- `text/markdown` for Markdown files
- `application/json` for JSON data
- `foundry/task` for task data (regardless of storage format)
- `foundry/prd` for PRD documents

### Metadata

Additional information about a resource that isn't part of its primary content. Metadata is stored as key-value pairs and might include:

- Creation timestamp
- Last modified timestamp
- Owner/creator information
- Version information
- Custom attributes

## Implementation Details

### File System Adapter

The File System Adapter maps operations directly to the local file system.

#### Implementation Notes

- **Paths**: Map directly to file system paths
- **Content**: Stored as actual files
- **Type**: Determined by file extension or stored in metadata
- **Metadata**: Stored in a hidden `.foundry` directory alongside the content files

```typescript
class FileSystemAdapter implements Adapter {
  constructor(options: { basePath: string; metadataDir?: string }) {
    this.basePath = options.basePath;
    this.metadataDir = options.metadataDir || ".foundry";
  }

  async read(path: string): Promise<{ content: string; type: string } | null> {
    const fullPath = this.resolvePath(path);

    if (!fs.existsSync(fullPath)) {
      return null;
    }

    const content = await fs.promises.readFile(fullPath, "utf-8");
    const metadata = await this.getMetadata(path);
    const type = metadata?.type || this.inferTypeFromPath(path);

    return { content, type };
  }

  async write(path: string, content: string, type: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);
    const dirPath = this.getDirPath(fullPath);

    // Ensure directory exists
    await fs.promises.mkdir(dirPath, { recursive: true });

    // Write content
    await fs.promises.writeFile(fullPath, content, "utf-8");

    // Store type in metadata
    const metadata = (await this.getMetadata(path)) || {};
    metadata.type = type;
    await this.setMetadata(path, metadata);

    return true;
  }

  // Other method implementations...

  private resolvePath(path: string): string {
    // Convert adapter path to actual file system path
    return nodePath.join(this.basePath, path);
  }

  private inferTypeFromPath(path: string): string {
    // Infer content type from file extension
    const ext = nodePath.extname(path).toLowerCase();
    switch (ext) {
      case ".md":
        return "text/markdown";
      case ".json":
        return "application/json";
      default:
        return "text/plain";
    }
  }
}
```

### In-Memory Adapter

The In-Memory Adapter stores all data in memory using JavaScript objects.

#### Implementation Notes

- **Paths**: Used as keys in a Map structure
- **Content**: Stored as string values
- **Type**: Stored alongside content in memory
- **Metadata**: Stored in a separate Map keyed by path

```typescript
class InMemoryAdapter implements Adapter {
  private content: Map<string, { content: string; type: string }> = new Map();
  private metadata: Map<string, Record<string, any>> = new Map();

  async read(path: string): Promise<{ content: string; type: string } | null> {
    return this.content.get(path) || null;
  }

  async write(path: string, content: string, type: string): Promise<boolean> {
    // Create parent directories if needed
    const dirPath = this.getDirPath(path);
    if (dirPath && !this.content.has(dirPath)) {
      await this.createDirectory(dirPath);
    }

    this.content.set(path, { content, type });
    return true;
  }

  async list(path: string): Promise<string[]> {
    const result: string[] = [];
    const prefix = path.endsWith("/") ? path : path + "/";

    for (const storedPath of this.content.keys()) {
      if (storedPath.startsWith(prefix)) {
        // Get the next path segment
        const relativePath = storedPath.slice(prefix.length);
        const nextSegment = relativePath.split("/")[0];

        if (nextSegment && !result.includes(nextSegment)) {
          result.push(nextSegment);
        }
      }
    }

    return result;
  }

  // Other method implementations...
}
```

## Using Adapters in the Core Library

The Core Library uses adapters to store and retrieve domain-specific data by mapping the domain concepts to paths and content.

### Example: Task Management

```typescript
class TaskManager {
  constructor(private adapter: Adapter) {}

  async getTask(id: string): Promise<Task | null> {
    const path = `tasks/${id}.md`;
    const result = await this.adapter.read(path);

    if (!result) {
      return null;
    }

    // Parse the Markdown content into a Task object
    return this.parseTaskMarkdown(result.content);
  }

  async saveTask(task: Task): Promise<boolean> {
    const path = `tasks/${task.id}.md`;
    const content = this.formatTaskAsMarkdown(task);

    return await this.adapter.write(path, content, "foundry/task");
  }

  async listTasks(): Promise<string[]> {
    const paths = await this.adapter.list("tasks");
    return paths
      .filter((path) => path.endsWith(".md"))
      .map((path) => path.replace(/\.md$/, ""));
  }

  // Helper methods for transforming between domain models and storage format
  private parseTaskMarkdown(markdown: string): Task {
    // Extract task data from Markdown content
    // ...
  }

  private formatTaskAsMarkdown(task: Task): string {
    // Format task as Markdown
    // ...
  }
}
```

## Adapter Selection and Fallback

Adapters are selected and configured when initializing a Consumer:

```typescript
const foundry = new Foundry({
  adapter: new FileSystemAdapter({
    basePath: "./my-project",
  }),
  fallbackAdapter: new InMemoryAdapter(),
});
```

The system will attempt to use the primary adapter for all operations. If an operation fails or the adapter is unavailable, it will automatically fall back to the fallback adapter if configured.

### Command Line Interface Defaults

When using the CLI without explicit configuration, it automatically selects:

1. File System Adapter as the primary adapter (using the current directory as base path)
2. In-Memory Adapter as the fallback adapter

## Collaboration and Resource Locking

For collaborative scenarios where multiple users may access and modify the same resources, resource locking mechanisms will be needed. These are planned for future implementation.

### Future Locking Interface

```typescript
interface CollaborativeAdapter extends Adapter {
  // Lock Operations
  lock(path: string, owner: string, ttl?: number): Promise<boolean>;
  unlock(path: string, owner: string): Promise<boolean>;
  isLocked(
    path: string,
  ): Promise<{ locked: boolean; owner?: string; expiresAt?: Date } | null>;

  // Conflict Resolution
  getVersion(path: string): Promise<string>;
  resolveConflict(
    path: string,
    versions: string[],
  ): Promise<{ content: string; type: string }>;
}
```

### Locking Strategies

Different adapters may implement different locking strategies based on their underlying technologies:

- **File System**: File-based locks via lock files
- **Database**: Transactional locks or row-level locking
- **Distributed**: Lease-based locks with timeouts
- **Optimistic Concurrency**: Version-based conflict detection and resolution

This is a planned feature and the exact implementation will be determined as collaborative features are developed.

## Custom Adapter Development

To develop a custom adapter:

1. Implement the Adapter interface
2. Implement the transform interface if needed
3. Optionally expose additional configuration options specific to your adapter

### Example: GitHub API Adapter (Planned)

```typescript
class GitHubAdapter implements Adapter {
  constructor(options: {
    repository: string;
    owner: string;
    token: string;
    branch?: string;
  }) {
    // Initialize with GitHub API configuration
  }

  async read(path: string): Promise<{ content: string; type: string } | null> {
    try {
      // Get file content from GitHub API
      const response = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repository,
        path,
        ref: this.branch,
      });

      // Decode content (GitHub API returns base64)
      const content = Buffer.from(response.data.content, "base64").toString(
        "utf-8",
      );

      // Determine content type
      const type = this.inferTypeFromPath(path);

      return { content, type };
    } catch (error) {
      // Handle 404 and other errors
      return null;
    }
  }

  // Other method implementations...
}
```

## Future Enhancements

1. **Synchronization**: Ability to synchronize between different adapters
2. **Caching Layer**: Performance optimization for expensive adapter operations
3. **Collaboration Features**: Implementation of locking and conflict resolution for multi-user scenarios
4. **Adapters for Additional Systems**:
   - Convex Database
   - Cloud Storage (S3, Google Cloud Storage)
   - Remote File Systems (SFTP, WebDAV)
