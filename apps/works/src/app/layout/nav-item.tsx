import type { ComponentType } from "react";
import { NavLink, useMatch } from "react-router";
import { Button } from "~/app/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/app/components/tooltip";
import { cn } from "~/app/lib/cn";

export interface NavItemConfig {
  end?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  to: string;
}

export function NavItem({ to, icon: Icon, label, end = false }: NavItemConfig) {
  const match = useMatch({ end, path: to });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-current={match ? "page" : undefined}
          asChild
          className={cn(
            "[&_svg]:pointer-events-auto",
            match
              ? "bg-foreground/[0.07] text-foreground"
              : "text-foreground/30 hover:bg-foreground/[0.04] hover:text-foreground/70"
          )}
          size="icon"
          variant="raised"
        >
          <NavLink aria-label={label} end={end} to={to}>
            <Icon className="size-4.5 shrink-0" />
          </NavLink>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="text-xs" side="right">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
