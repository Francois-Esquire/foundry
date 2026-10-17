import type { ComponentType, KeyboardEvent } from "react";
import { NavLink, useMatch } from "react-router";
import { Button } from "~/app/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/app/components/tooltip";
import { cn } from "~/app/lib/cn";
import { moveFocusAmong } from "~/app/lib/focus";

export interface NavItemConfig {
  end?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  to: string;
}

/**
 * Every link stays in the Tab order; the arrow keys also step through the
 * whole rail top to bottom, wrapping, and Home/End jump to either end.
 */
function moveRailFocus(event: KeyboardEvent<HTMLAnchorElement>) {
  const links = [
    ...(event.currentTarget
      .closest("nav")
      ?.querySelectorAll<HTMLElement>("a[href]") ?? []),
  ];
  moveFocusAmong(event, links, { wrap: true });
}

export function NavItem({ to, icon: Icon, label, end = false }: NavItemConfig) {
  const match = useMatch({ end, path: to });

  return (
    <li>
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
            <NavLink
              aria-label={label}
              end={end}
              onKeyDown={moveRailFocus}
              to={to}
            >
              <Icon className="size-4.5 shrink-0" />
            </NavLink>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="text-xs" side="right">
          {label}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}
