/** Unicode blocks: named, contiguous ranges of the code space. */
import { isCodePoint } from "./characters";
import { BLOCKS } from "./data/properties";

export interface Block {
  readonly first: number;
  readonly last: number;
  /** As in the Unicode charts, for example Latin-1 Supplement. */
  readonly name: string;
}

const allBlocks: readonly Block[] = BLOCKS.split(";").map((row) => {
  const [first = "0", last = "0", name = ""] = row.split("|");
  return {
    first: Number.parseInt(first, 36),
    last: Number.parseInt(last, 36),
    name,
  };
});

const blocksByName = new Map(allBlocks.map((block) => [block.name, block]));

/** Every block in code point order. */
export const blocks = (): readonly Block[] => allBlocks;

export const findBlock = (name: string): Block | undefined =>
  blocksByName.get(name);

/** The block holding a code point. Undefined where no block is defined. */
export const blockOf = (codePoint: number): Block | undefined => {
  let low = 0;
  let high = isCodePoint(codePoint) ? allBlocks.length - 1 : -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const block = allBlocks[middle];
    if (!block) {
      return;
    }
    if (codePoint < block.first) {
      high = middle - 1;
    } else if (codePoint > block.last) {
      low = middle + 1;
    } else {
      return block;
    }
  }
};
