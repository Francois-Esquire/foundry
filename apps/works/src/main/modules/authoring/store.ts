import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  hasErrorCode,
  readJsonFile,
  writeFileAtomic,
} from "@foundry/lib/atomic-file";
import type {
  AuthoringRoute,
  AuthoringTurnView,
  ProposalFiles,
} from "~/shared/authoring";
import type { ModuleSourceRevision } from "~/shared/modules";
import { moduleDirectory } from "../local-library";

/**
 * Works authoring state: per Module, the conversation's Agent Session and
 * route, each turn's record, the Draft snapshot it started from and the
 * Edit proposal it captured. This is the chat's own state, apart from the
 * engine's redacted run records; answers to questions are never written.
 *
 * Layout under the root, per Module folder:
 * `conversation.json`, `turns/<turn>.json`, `turns/<turn>.snapshot.json`
 * (written once, before the turn has any effect) and
 * `turns/<turn>.proposal.json` (written once, when the turn captures it).
 */

export interface ConversationRecord {
  readonly route?: AuthoringRoute;
  readonly sessionId?: string;
}

export interface TurnRecord extends AuthoringTurnView {
  readonly agentSessionId: string;
  /** The saved source the Draft was bound to when the turn started. */
  readonly binding: ModuleSourceRevision;
  readonly moduleId: string;
  runId?: string;
}

interface Snapshot {
  readonly source: Record<string, string>;
}

export class AuthoringStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #module(moduleId: string) {
    return path.join(this.#root, moduleDirectory(moduleId));
  }

  #turn(moduleId: string, turnId: string, kind = "") {
    if (!UUID.test(turnId)) {
      throw new Error("Unknown authoring turn");
    }
    return path.join(this.#module(moduleId), "turns", `${turnId}${kind}.json`);
  }

  async conversation(moduleId: string): Promise<ConversationRecord> {
    return (
      (await readJson<ConversationRecord>(
        path.join(this.#module(moduleId), "conversation.json")
      )) ?? {}
    );
  }

  writeConversation(moduleId: string, record: ConversationRecord) {
    return writeJson(
      path.join(this.#module(moduleId), "conversation.json"),
      record
    );
  }

  /** Every turn record of the Module, oldest first. */
  async turns(moduleId: string): Promise<TurnRecord[]> {
    const directory = path.join(this.#module(moduleId), "turns");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    const turns = await Promise.all(
      names
        .filter((name) => TURN_FILE.test(name))
        .map((name) => readJson<TurnRecord>(path.join(directory, name)))
    );
    return turns
      .filter((turn): turn is TurnRecord => turn !== undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  writeTurn(turn: TurnRecord) {
    return writeJson(this.#turn(turn.moduleId, turn.id), turn);
  }

  writeSnapshot(
    moduleId: string,
    turnId: string,
    source: Record<string, string>
  ) {
    return writeJson(this.#turn(moduleId, turnId, ".snapshot"), {
      source,
    } satisfies Snapshot);
  }

  async snapshot(
    moduleId: string,
    turnId: string
  ): Promise<Record<string, string>> {
    const snapshot = await readJson<Snapshot>(
      this.#turn(moduleId, turnId, ".snapshot")
    );
    if (!snapshot) {
      throw new Error("The draft this request started from is missing");
    }
    return snapshot.source;
  }

  writeProposal(moduleId: string, turnId: string, changes: ProposalFiles) {
    return writeJson(this.#turn(moduleId, turnId, ".proposal"), changes);
  }

  async proposal(moduleId: string, turnId: string): Promise<ProposalFiles> {
    const changes = await readJson<ProposalFiles>(
      this.#turn(moduleId, turnId, ".proposal")
    );
    if (!changes) {
      throw new Error("The proposed changes are missing");
    }
    return changes;
  }

  /** Remove a turn with its snapshot and proposal. */
  async remove(moduleId: string, turnId: string) {
    await Promise.all(
      ["", ".snapshot", ".proposal"].map((kind) =>
        rm(this.#turn(moduleId, turnId, kind), { force: true })
      )
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TURN_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;

/** The JSON at `file` as this store wrote it; undefined when missing. */
async function readJson<T>(file: string): Promise<T | undefined> {
  return (await readJsonFile(file)) as T | undefined;
}

function writeJson(file: string, value: unknown): Promise<void> {
  return writeFileAtomic(file, JSON.stringify(value), {
    directoryMode: 0o700,
    mode: 0o600,
  });
}
