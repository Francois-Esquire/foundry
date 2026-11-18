export type CellValue =
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "empty" }
  | {
      readonly kind: "error";
      readonly value: string;
      readonly message: string;
    }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly value: string };
