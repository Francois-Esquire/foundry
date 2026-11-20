export function environmentOverlay<R extends string | undefined>(
  target: Readonly<Record<string, string>>,
  removed: R,
  ambient: NodeJS.ProcessEnv = process.env
): Record<string, string | R> {
  const overlay: Record<string, string | R> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value !== undefined && !Object.hasOwn(target, name)) {
      overlay[name] = removed;
    }
  }
  for (const [name, value] of Object.entries(target)) {
    if (ambient[name] !== value) {
      overlay[name] = value;
    }
  }
  return overlay;
}

export function liveEnvironmentOverlay<R extends string | undefined>(
  target: Readonly<Record<string, string>>,
  removed: R
): Record<string, string | R> {
  const now = () => environmentOverlay(target, removed);
  return new Proxy<Record<string, string | R>>(
    {},
    {
      get: (_, name) => (typeof name === "string" ? now()[name] : undefined),
      getOwnPropertyDescriptor: (_, name) => {
        const overlay = now();
        return typeof name === "string" && Object.hasOwn(overlay, name)
          ? { configurable: true, enumerable: true, value: overlay[name] }
          : undefined;
      },
      has: (_, name) => typeof name === "string" && Object.hasOwn(now(), name),
      ownKeys: () => Object.keys(now()),
    }
  );
}
