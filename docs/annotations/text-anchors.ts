import type {
  Point,
  TextAnchors,
  TextRect,
  TextSegment,
  TextTarget,
} from "./model.ts";

interface TextPart {
  end: number;
  node: Text;
  start: number;
}

interface TextBlock {
  element: HTMLElement;
  id: string;
  parts: TextPart[];
  text: string;
}

const EXCLUDED =
  "button,script,style,[aria-hidden=true],[hidden],.annotation-host";
const WORDS = /\S+/g;
const MAX_SEGMENTS = 32;
const MAX_QUOTE = 8000;
const MAX_PROXIMITY = 24;

/** Resolve saved text meaning to live line boxes; no spans or prose mutations. */
export function createTextAnchors(
  article: HTMLElement,
  host: HTMLElement
): TextAnchors {
  let disposed = false;

  function blocks(): TextBlock[] {
    if (disposed) {
      return [];
    }
    const indexed = new Map<HTMLElement, TextBlock>();
    for (const element of article.querySelectorAll<HTMLElement>(
      "[data-annotation-anchor]"
    )) {
      if (host.contains(element) || element.closest(EXCLUDED)) {
        continue;
      }
      indexed.set(element, {
        element,
        id: element.dataset.annotationAnchor ?? "",
        parts: [],
        text: "",
      });
    }
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      const owner = parent?.closest<HTMLElement>("[data-annotation-anchor]");
      const block = owner ? indexed.get(owner) : undefined;
      if (block && parent && !parent.closest(EXCLUDED)) {
        const value = node.textContent ?? "";
        block.parts.push({
          end: block.text.length + value.length,
          node: node as Text,
          start: block.text.length,
        });
        block.text += value;
      }
      node = walker.nextNode();
    }
    return [...indexed.values()].filter((block) => block.text.trim());
  }

  function makeSegment(
    block: TextBlock,
    start: number,
    end: number
  ): TextSegment {
    return {
      blockId: block.id,
      end,
      prefix: block.text.slice(Math.max(0, start - 24), start),
      quote: block.text.slice(start, end),
      start,
      suffix: block.text.slice(end, end + 24),
    };
  }

  function rangeFor(
    block: TextBlock,
    start: number,
    end: number
  ): Range | null {
    const first = block.parts.find((part) => start < part.end);
    const last = block.parts.find(
      (part) => end <= part.end && end > part.start
    );
    if (!(first && last) || end <= start) {
      return null;
    }
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }

  function segmentForSelection(block: TextBlock, selected: Range) {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (const part of block.parts) {
      if (!selected.intersectsNode(part.node)) {
        continue;
      }
      const partRange = document.createRange();
      partRange.selectNodeContents(part.node);
      if (
        selected.compareBoundaryPoints(Range.END_TO_START, partRange) >= 0 ||
        selected.compareBoundaryPoints(Range.START_TO_END, partRange) <= 0
      ) {
        continue;
      }
      const from =
        selected.startContainer === part.node ? selected.startOffset : 0;
      const to =
        selected.endContainer === part.node
          ? selected.endOffset
          : part.node.length;
      start = Math.min(start, part.start + from);
      end = Math.max(end, part.start + to);
    }
    if (end <= start) {
      return null;
    }
    const quote = block.text.slice(start, end);
    start += quote.length - quote.trimStart().length;
    end -= quote.length - quote.trimEnd().length;
    return end > start ? makeSegment(block, start, end) : null;
  }

  function captureSelection(): TextTarget | null {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
      return null;
    }
    const selected = selection.getRangeAt(0);
    if (
      !(
        article.contains(selected.startContainer) &&
        article.contains(selected.endContainer)
      ) ||
      host.contains(selected.startContainer) ||
      host.contains(selected.endContainer)
    ) {
      return null;
    }
    const segments = blocks()
      .map((block) => segmentForSelection(block, selected))
      .filter((segment): segment is TextSegment => segment !== null);
    const length = segments.reduce(
      (total, segment) => total + segment.quote.length,
      0
    );
    return segments.length > 0 &&
      segments.length <= MAX_SEGMENTS &&
      length <= MAX_QUOTE
      ? { segments }
      : null;
  }

  function contextMatches(
    block: TextBlock,
    segment: TextSegment,
    start: number
  ) {
    const end = start + segment.quote.length;
    return (
      block.text.slice(Math.max(0, start - segment.prefix.length), start) ===
        segment.prefix &&
      block.text.slice(end, end + segment.suffix.length) === segment.suffix
    );
  }

  function quoteMatches(segment: TextSegment, all: TextBlock[]) {
    const matches: {
      block: TextBlock;
      start: number;
      end: number;
      contextual: boolean;
    }[] = [];
    for (const block of all) {
      let start = block.text.indexOf(segment.quote);
      while (start !== -1) {
        matches.push({
          block,
          contextual: contextMatches(block, segment, start),
          end: start + segment.quote.length,
          start,
        });
        if (matches.length > 1000) {
          return null;
        }
        start = block.text.indexOf(segment.quote, start + 1);
      }
    }
    return matches;
  }

  function findSegment(segment: TextSegment, all: TextBlock[]) {
    if (!segment.quote || segment.end <= segment.start) {
      return null;
    }
    const original = all.find((block) => block.id === segment.blockId);
    if (
      original?.text.slice(segment.start, segment.end) === segment.quote &&
      contextMatches(original, segment, segment.start)
    ) {
      return { block: original, end: segment.end, start: segment.start };
    }
    const matches = quoteMatches(segment, all);
    if (!matches) {
      return null;
    }
    const contextual = matches.filter((match) => match.contextual);
    if (contextual.length === 1) {
      return contextual[0] ?? null;
    }
    return contextual.length === 0 && matches.length === 1
      ? (matches[0] ?? null)
      : null;
  }

  function mergeLineRects(rects: TextRect[]): TextRect[] {
    const lines: TextRect[] = [];
    for (const rect of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const line = lines.find(
        (candidate) =>
          Math.abs(candidate.y - rect.y) <= 4 &&
          Math.min(candidate.y + candidate.height, rect.y + rect.height) -
            Math.max(candidate.y, rect.y) >
            Math.min(candidate.height, rect.height) * 0.6
      );
      if (!line) {
        lines.push({ ...rect });
        continue;
      }
      const right = Math.max(line.x + line.width, rect.x + rect.width);
      const bottom = Math.max(line.y + line.height, rect.y + rect.height);
      line.x = Math.min(line.x, rect.x);
      line.y = Math.min(line.y, rect.y);
      line.width = right - line.x;
      line.height = bottom - line.y;
    }
    return lines;
  }

  function rectsFor(range: Range): TextRect[] {
    const origin = host.getBoundingClientRect();
    return mergeLineRects(
      [...range.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({
          height: rect.height,
          width: rect.width,
          x: rect.left - origin.left,
          y: rect.top - origin.top,
        }))
    );
  }

  function resolveTarget(target: TextTarget): TextRect[] | null {
    const all = blocks();
    const rects: TextRect[] = [];
    for (const segment of target.segments) {
      const match = findSegment(segment, all);
      const range = match
        ? rangeFor(match.block, match.start, match.end)
        : null;
      if (!range) {
        return null;
      }
      rects.push(...rectsFor(range));
    }
    return rects.length ? rects : null;
  }

  function wordRects(block: TextBlock) {
    const result: {
      block: TextBlock;
      start: number;
      end: number;
      rect: TextRect;
    }[] = [];
    for (const word of block.text.matchAll(WORDS)) {
      const start = word.index;
      const end = start + word[0].length;
      const range = rangeFor(block, start, end);
      if (!range) {
        continue;
      }
      for (const rect of rectsFor(range)) {
        result.push({ block, end, rect, start });
      }
      if (result.length > 10_000) {
        break;
      }
    }
    return result;
  }

  function words() {
    return blocks()
      .filter((block) => {
        const bounds = block.element.getBoundingClientRect();
        return bounds.bottom >= 0 && bounds.top <= window.innerHeight;
      })
      .flatMap(wordRects)
      .slice(0, 10_000);
  }

  function targetAtPoint(point: Point): TextTarget | null {
    const candidates = words()
      .map((word) => {
        const { rect } = word;
        const dx = Math.max(rect.x - point.x, 0, point.x - rect.x - rect.width);
        const dy = Math.max(
          rect.y - point.y,
          0,
          point.y - rect.y - rect.height
        );
        return { ...word, distance: Math.hypot(dx, dy) };
      })
      .filter((word) => word.distance <= MAX_PROXIMITY)
      .sort((a, b) => a.distance - b.distance);
    const [first, second] = candidates;
    if (!first || (second && Math.abs(second.distance - first.distance) < 2)) {
      return null;
    }
    return { segments: [makeSegment(first.block, first.start, first.end)] };
  }

  function targetForStroke(points: Point[]): TextTarget | null {
    if (points.length < 2) {
      return null;
    }
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    if (
      right - left < 16 ||
      bottom - top > Math.min(24, (right - left) * 0.25)
    ) {
      return null;
    }
    const y = (top + bottom) / 2;
    const candidates = words().filter(({ rect }) => {
      const wordCenter = rect.x + rect.width / 2;
      const below = y - (rect.y + rect.height);
      return (
        wordCenter >= left && wordCenter <= right && below >= -3 && below <= 14
      );
    });
    const [first] = candidates;
    if (
      !first ||
      candidates.some(
        (word) =>
          word.block !== first.block || Math.abs(word.rect.y - first.rect.y) > 4
      )
    ) {
      return null;
    }
    const start = Math.min(...candidates.map((word) => word.start));
    const end = Math.max(...candidates.map((word) => word.end));
    return { segments: [makeSegment(first.block, start, end)] };
  }

  return {
    captureSelection,
    dispose: () => {
      disposed = true;
    },
    resolveTarget,
    targetAtPoint,
    targetForStroke,
  };
}
