export interface Adapter {
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
