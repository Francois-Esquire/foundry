// Contract with one implementation here and one in store.
export interface Repo {
  get(id: string): string | undefined;
  put(id: string, value: string): void;
}

export function countRepo(repo: Repo): number {
  return repo.get("x") === undefined ? 0 : 1;
}
