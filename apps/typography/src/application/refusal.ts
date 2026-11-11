/**
 * What a command throws when it will not do what it was asked. The message is
 * one plain sentence, or a few, that names the problem and the way out.
 * Anything else a command throws is a fault in the app.
 */
export class Refusal extends Error {
  override readonly name = "Refusal";
}
