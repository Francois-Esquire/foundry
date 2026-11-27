export class NotHostedError extends Error {
  override readonly name: string = "NotHostedError";
}

export class NotReadyError extends NotHostedError {
  override readonly name = "NotReadyError";
}

export class RecordsHeldError extends Error {
  override readonly name = "RecordsHeldError";
}
