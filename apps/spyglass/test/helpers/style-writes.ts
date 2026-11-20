export function recordStyleWrites(element: HTMLElement): string[] {
  const writes: string[] = [];
  const { style } = element;
  Object.defineProperty(element, "style", {
    configurable: true,
    value: new Proxy(style, {
      set(target, property, value) {
        writes.push(String(property));
        return Reflect.set(target, property, value);
      },
    }),
  });
  return writes;
}
