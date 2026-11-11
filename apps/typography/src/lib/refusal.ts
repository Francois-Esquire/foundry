/**
 * What an operation throws when it will not go on, and what a command throws
 * when it will not do what it was asked. The message is one plain sentence,
 * or a few, that names the problem and the way out.
 */
export class Refusal extends Error {
  override readonly name = "Refusal";
}
