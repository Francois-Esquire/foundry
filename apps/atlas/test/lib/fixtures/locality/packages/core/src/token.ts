// Broadly referenced semantic type with one factory.
export type Token = string;

export function newToken(): Token {
  return "t";
}
