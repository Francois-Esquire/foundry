import { Hint } from "@/components/blocks/hint";
import { ListRow } from "@/components/blocks/list-row";
import { useTheme } from "@/hooks/use-theme";
import type { Skill } from "@/model/context";

export function SkillList({ skills }: { readonly skills: readonly Skill[] }) {
  const theme = useTheme();
  if (skills.length === 0) {
    return <Hint>No skills in .claude/skills here.</Hint>;
  }
  return (
    <>
      {skills.map((skill) => (
        <ListRow
          color={theme.colors.foreground}
          icon="◆"
          key={skill.name}
          note={skill.description}
        >
          {skill.name}
        </ListRow>
      ))}
      <box marginTop={1}>
        <Hint>From .claude/skills. The worker has these and no others.</Hint>
      </box>
    </>
  );
}
