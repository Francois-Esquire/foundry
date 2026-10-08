import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { type ComponentType, type CSSProperties, useCallback } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/app/components/dropdown-menu";
import { cn } from "~/app/lib/cn";
import { type ThemeMode, useTheme } from "~/app/theme/theme";

interface ThemeOption {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: ThemeMode;
}

const THEMES: ThemeOption[] = [
  { icon: MonitorIcon, label: "System", value: "auto" },
  { icon: SunIcon, label: "Light", value: "light" },
  { icon: MoonIcon, label: "Dark", value: "dark" },
];

const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

function ThemePillButton({ icon: Icon, label, value }: ThemeOption) {
  const { themeMode, setTheme } = useTheme();
  const select = useCallback(() => {
    setTheme(value);
  }, [setTheme, value]);
  const active = themeMode === value;

  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded-full transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
      onClick={select}
      type="button"
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

/** Full segmented pill: System, Light, and Dark all visible. */
export function ThemeSelector() {
  return (
    <div className="flex rounded-full bg-muted/60 p-0.5">
      {THEMES.map((theme) => (
        <ThemePillButton key={theme.value} {...theme} />
      ))}
    </div>
  );
}

function ThemeMenuItem({ icon: Icon, label, value }: ThemeOption) {
  const { themeMode, setTheme } = useTheme();
  const select = useCallback(() => {
    setTheme(value);
  }, [setTheme, value]);

  return (
    <DropdownMenuItem
      className={cn(themeMode === value && "font-medium text-foreground")}
      onClick={select}
    >
      <Icon className="h-4 w-4" />
      {label}
    </DropdownMenuItem>
  );
}

/** The same choices folded into a dropdown for a cramped title bar. */
export function ThemeSelectorCompact() {
  const { themeMode } = useTheme();
  const active = THEMES.find((theme) => theme.value === themeMode);
  const ActiveIcon = active?.icon ?? MonitorIcon;
  const activeLabel = active?.label ?? "System";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Theme: ${activeLabel}`}
        className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        style={NO_DRAG}
      >
        <ActiveIcon className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {THEMES.map((theme) => (
          <ThemeMenuItem key={theme.value} {...theme} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
