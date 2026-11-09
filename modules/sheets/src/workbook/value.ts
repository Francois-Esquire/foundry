/**
 * What a cell shows once calculated. A formula that cannot be calculated
 * (bad syntax, a missing sheet, a division by zero, a cycle) has an error
 * value such as `#DIV/0!`; it is not a refused edit.
 */
export type CellValue =
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "empty" }
  | {
      readonly kind: "error";
      /** The spreadsheet error, such as `#REF!`. */
      readonly value: string;
      readonly message: string;
    }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly value: string };
