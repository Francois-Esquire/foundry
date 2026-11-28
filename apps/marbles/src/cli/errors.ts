import { ReentrantCallError } from "@foundry/lib/turns";
import { DatabaseBusyError } from "~/database/busy";
import { IncompatibleDatabaseError } from "~/database/migrate";
import { UnreadableDatabaseError } from "~/database/open";
import { TaskStorageError } from "~/database/tasks";
import { ResourceNotFoundError } from "~/lib/definitions/resources";
import { ConfigurationError } from "~/lib/providers/store";
import { RunEndedError } from "~/lib/runs/followed";
import { RunOutputError } from "~/lib/runs/output";
import { NotHostedError, RecordsHeldError } from "~/model/errors";
import {
  NoProcessError,
  ProcessMismatchError,
  ProcessTimeoutError,
} from "~/process/client";
import { ProcessHeldError } from "~/process/instance";
import { RemoteError } from "~/process/protocol";
import { LaunchInputError } from "~/workspace/host";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export function isActionableError(error: unknown): error is Error {
  return (
    error instanceof UsageError ||
    error instanceof ConfigurationError ||
    error instanceof DatabaseBusyError ||
    error instanceof IncompatibleDatabaseError ||
    error instanceof LaunchInputError ||
    error instanceof NoProcessError ||
    error instanceof NotHostedError ||
    error instanceof ProcessMismatchError ||
    error instanceof ProcessTimeoutError ||
    error instanceof ProcessHeldError ||
    error instanceof RecordsHeldError ||
    error instanceof ReentrantCallError ||
    error instanceof RemoteError ||
    error instanceof ResourceNotFoundError ||
    error instanceof RunEndedError ||
    error instanceof RunOutputError ||
    error instanceof TaskStorageError ||
    error instanceof UnreadableDatabaseError
  );
}
