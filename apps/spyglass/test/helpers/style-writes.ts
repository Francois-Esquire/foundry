/**
 * Records every style property set on an element from now on, by name and
 * in order, through a proxy shadowing its `style`. happy-dom's own
 * declaration is a proxy no spy can wrap, and it keeps no value for a
 * vendor property such as `webkitTextStroke`, so a test reads the writes,
 * not the values.
 */
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
