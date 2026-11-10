/** Everything the studio shows about one character. */
import { type Block, blockOf } from "./blocks";
import {
  categoryName,
  categoryOf,
  type GeneralCategory,
  isAssigned,
  isCombiningMark,
  scriptOf,
} from "./characters";
import { formatCodePoint } from "./code-point";
import { characterName } from "./names";

export interface CharacterIdentity {
  readonly assigned: boolean;
  readonly block: Block | undefined;
  readonly category: GeneralCategory;
  /** The category in words, for example Other Letter. */
  readonly categoryName: string;
  readonly codePoint: number;
  /** True for a combining mark, which needs a base character to sit on. */
  readonly combining: boolean;
  /** U+0915. */
  readonly label: string;
  /** Undefined where Unicode gives no name: unassigned, private use, controls. */
  readonly name: string | undefined;
  /** ISO 15924: Deva, Zyyy for Common, Zinh for Inherited, Zzzz for none. */
  readonly script: string;
}

export const describeCharacter = async (
  codePoint: number
): Promise<CharacterIdentity> => {
  const category = categoryOf(codePoint);
  return {
    assigned: isAssigned(codePoint),
    block: blockOf(codePoint),
    category,
    categoryName: categoryName(category),
    codePoint,
    combining: isCombiningMark(codePoint),
    label: formatCodePoint(codePoint),
    name: await characterName(codePoint),
    script: scriptOf(codePoint),
  };
};
