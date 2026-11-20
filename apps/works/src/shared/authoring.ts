export type AuthoringTurnStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AuthoringToolStatus =
  | "running"
  | "complete"
  | "failed"
  | "denied"
  | "cancelled";

interface AuthoringQuestion {
  header?: string;
  id: string;
  multiSelect?: boolean;
  options?: { description?: string; label: string }[];
  question: string;
}

type AuthoringInputStatus =
  | "open"
  | "answered"
  | "declined"
  | "cancelled"
  | "interrupted";

export type AuthoringItem =
  | { kind: "text"; text: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      reason?: string;
      status: AuthoringToolStatus;
    }
  | {
      id: string;
      kind: "question";
      questions: AuthoringQuestion[];
      status: AuthoringInputStatus;
    }
  | {
      id: string;
      kind: "approval";
      status: AuthoringInputStatus;
      summary: string;
      toolName: string;
    };

type AuthoringProposalStatus = "pending" | "applied" | "dismissed";

export interface AuthoringProposalView {
  paths: string[];
  status: AuthoringProposalStatus;
}

export interface AuthoringRoute {
  model: string;
  provider: string;
}

export interface AuthoringTurnView {
  createdAt: string;
  error?: string;
  id: string;
  items: AuthoringItem[];
  notice?: string;
  prompt: string;
  proposal?: AuthoringProposalView;
  route: AuthoringRoute;
  status: AuthoringTurnStatus;
  waiting?: boolean;
}

export interface AuthoringConversationView {
  moduleId: string;
  turns: AuthoringTurnView[];
}

export type AuthoringEvent =
  | { conversation: AuthoringConversationView; type: "conversation" }
  | { turn: AuthoringTurnView; type: "turn" }
  | { delta: string; turnId: string; type: "text" };

export type ProposalFiles = Record<string, string | null>;

export interface AuthoringProposalFiles {
  base: ProposalFiles;
  proposal: ProposalFiles;
}

export type AuthoringAcceptResult =
  | ({ status: "ready" } & AuthoringProposalFiles)
  | { message: string; status: "stale" };

export type AuthoringAnswer =
  | { answers: Record<string, string[]>; kind: "answer" }
  | { kind: "decline"; reason?: string }
  | { approved: boolean; kind: "approval" };

export function isSettledTurn(status: AuthoringTurnStatus): boolean {
  return status !== "queued" && status !== "running";
}

export function applyAuthoringEvent(
  conversation: AuthoringConversationView | null,
  event: AuthoringEvent
): AuthoringConversationView | null {
  if (event.type === "conversation") {
    return event.conversation;
  }
  if (!conversation) {
    return conversation;
  }
  if (event.type === "turn") {
    const index = conversation.turns.findIndex(
      (turn) => turn.id === event.turn.id
    );
    const turns =
      index === -1
        ? [...conversation.turns, event.turn]
        : conversation.turns.with(index, event.turn);
    return { ...conversation, turns };
  }
  return {
    ...conversation,
    turns: conversation.turns.map((turn) =>
      turn.id === event.turnId
        ? { ...turn, items: appendText(turn.items, event.delta) }
        : turn
    ),
  };
}

export function appendText(
  items: AuthoringItem[],
  delta: string
): AuthoringItem[] {
  const last = items.at(-1);
  if (last?.kind === "text") {
    return [...items.slice(0, -1), { kind: "text", text: last.text + delta }];
  }
  return [...items, { kind: "text", text: delta }];
}
