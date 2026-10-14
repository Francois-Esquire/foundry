export interface Store {
  get(key: string): string | undefined;
}
