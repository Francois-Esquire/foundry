export interface GenerateOptions {
  cache: string;
  onProgress: (message: string) => void;
  output: string;
  root: string;
}

/** Replace this body with the semantic-surface library binding during migration. */
export async function generate(_options: GenerateOptions): Promise<void> {
  throw new Error(
    "Atlas analysis is not connected yet. The CLI scaffold is ready for the semantic-surface library."
  );
}
