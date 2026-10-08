import type { ComponentProps } from "react";
import { Card } from "~/app/components/card";
import { cn } from "~/app/lib/cn";

export function SectionHeader({ id, title }: { id?: string; title: string }) {
  return (
    <h2
      className="m-0 mb-3 font-semibold text-foreground text-lg tracking-[-0.02em]"
      id={id}
    >
      {title}
    </h2>
  );
}

export function SectionCard({
  className,
  ...props
}: ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        "gap-0 divide-y divide-border overflow-hidden rounded-xl py-0 shadow-none",
        className
      )}
      {...props}
    />
  );
}
