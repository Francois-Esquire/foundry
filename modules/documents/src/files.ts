interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

export async function allFiles<T>(
  read: (input: { cursor?: string }) => Promise<Page<T>>
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await read(cursor === null ? {} : { cursor });
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== null);
  return items;
}
