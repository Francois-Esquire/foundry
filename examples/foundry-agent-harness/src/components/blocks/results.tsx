import type { Facts } from "@/game/facts";
import type { Scorecard } from "@/game/scorecard";
import { hud } from "@/model/palette";
import { compactCount } from "@/model/thread";

const MS_PER_SECOND = 1000;

function factLine({
  calls,
  duration,
  failedCalls,
  finished,
  left,
  steps,
  tokens,
  weapon,
}: Facts): string {
  return [
    `${finished}/${steps} steps`,
    `${calls} ${calls === 1 ? "call" : "calls"}, ${failedCalls} failed`,
    `${compactCount(tokens.input + tokens.output)} tokens`,
    `${Math.round(left * 100)}% left`,
    `${weapon.model}/${weapon.effort}`,
    `${Math.round(duration / MS_PER_SECOND)}s`,
  ].join(" · ");
}

function signed(amount: number): string {
  return amount < 0 ? `−${-amount}` : `+${amount}`;
}

function Key({
  action,
  name,
}: {
  readonly action: string;
  readonly name: string;
}) {
  return (
    <span>
      <span bg={hud.tint} fg={hud.amber}>{` ${name} `}</span>
      {` ${action}  `}
    </span>
  );
}

function FactRows({ facts }: { readonly facts: Facts }) {
  return (
    <box height={2} overflow="hidden">
      <text fg={hud.dim} wrapMode="word">
        {factLine(facts)}
      </text>
    </box>
  );
}

function Items({ scorecard }: { readonly scorecard: Scorecard }) {
  const items = [
    ...scorecard.items.filter((item) => item.amount < 0),
    ...scorecard.items.filter((item) => item.amount >= 0),
  ];
  return (
    <box height={3} overflow="hidden">
      <text fg={hud.text} wrapMode="word">
        {items.map((item, index) => (
          <span key={item.label}>
            {index > 0 ? <span fg={hud.faint}>{" · "}</span> : null}
            {`${item.label} `}
            <span fg={item.amount < 0 ? hud.red : hud.ok}>
              {signed(item.amount)}
            </span>
          </span>
        ))}
      </text>
    </box>
  );
}

export function resultsMeta(scorecard: Scorecard): string {
  if (scorecard.rank === null) {
    return "awaiting verdict";
  }
  return `RANK ${scorecard.rank} · ${signed(scorecard.total)} XP`;
}

export function Results({ scorecard }: { readonly scorecard: Scorecard }) {
  if (scorecard.verdict === "accept") {
    return <Items scorecard={scorecard} />;
  }
  return (
    <box flexDirection="column">
      <FactRows facts={scorecard.facts} />
      {scorecard.verdict === "reject" ? (
        <text fg={hud.red} wrapMode="none">
          Rejected · nothing banked
        </text>
      ) : (
        <text fg={hud.dim} wrapMode="none">
          <span fg={hud.bright}>{"Rank ?  "}</span>
          <Key action="Accept" name="A" />
          <Key action="Reject" name="R" />
          <Key action="Skip" name="Esc" />
        </text>
      )}
    </box>
  );
}
