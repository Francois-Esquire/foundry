/**
 * A small XML reader, enough for SVG files: elements, attributes and the
 * text directly inside an element. Comments, declarations and processing
 * instructions are skipped. It exists because a DOM parser is a browser
 * global and this context also runs in Node.
 */

export interface XmlElement {
  readonly attributes: Readonly<Record<string, string | undefined>>;
  readonly children: readonly XmlElement[];
  /** The tag name without a namespace prefix, for example `path`. */
  readonly name: string;
  readonly text: string;
}

export class MalformedXmlError extends Error {
  override readonly name = "MalformedXmlError";
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const ATTRIBUTE = /([^\s=/<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TAG = /<(\/?)([^\s/>!?]+)([^>]*?)(\/?)>/g;
const SKIPPED = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/gi;
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

const decodeEntities = (value: string): string =>
  value.replace(ENTITY, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

const localName = (name: string) => name.slice(name.indexOf(":") + 1);

const readAttributes = (source: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) {
    const [, name = "", double, single] = match;
    attributes[localName(name)] = decodeEntities(double ?? single ?? "");
  }
  return attributes;
};

interface OpenElement {
  readonly attributes: Record<string, string>;
  readonly children: XmlElement[];
  readonly name: string;
  text: string;
}

/** Character data keeps its text but must not be read as markup. */
const escapeCharacterData = (source: string) =>
  source.replace(CDATA, (_, body: string) =>
    body.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  );

/** Reads a document and returns its root element. */
export const parseXml = (source: string): XmlElement => {
  const stack: OpenElement[] = [];
  let root: XmlElement | undefined;
  const finish = (element: OpenElement) => {
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(element);
    } else {
      root ??= element;
    }
  };
  const markup = escapeCharacterData(source.replace(SKIPPED, ""));
  let textFrom = 0;
  for (const match of markup.matchAll(TAG)) {
    const [, closing, name = "", attributes = "", selfClosing] = match;
    const inside = stack.at(-1);
    if (inside) {
      inside.text += decodeEntities(markup.slice(textFrom, match.index));
    }
    textFrom = match.index + match[0].length;
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== localName(name)) {
        throw new MalformedXmlError(`Unexpected closing tag </${name}>.`);
      }
      finish(open);
      continue;
    }
    const element: OpenElement = {
      attributes: readAttributes(attributes),
      children: [],
      name: localName(name),
      text: "",
    };
    if (selfClosing) {
      finish(element);
    } else {
      stack.push(element);
    }
  }
  if (stack.length > 0 || !root) {
    throw new MalformedXmlError(
      root ? "The document ends inside an element." : "No element found."
    );
  }
  return root;
};
