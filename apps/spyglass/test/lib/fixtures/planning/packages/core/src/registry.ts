function shared(): string {
  return "shared";
}

export class Registry {
  list(): string {
    return shared();
  }
}

export function unrelated(): string {
  return shared();
}
