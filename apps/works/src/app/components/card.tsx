import type { ComponentProps } from "react";
import { cn } from "~/app/lib/cn";

export function Card({
  className,
  size = "default",
  ...props
}: ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      className={cn(
        // A fainter border on the edge plus an offset outline 2px out, reading
        // as a thin double border with a gap.
        "group/card flex flex-col gap-6 overflow-hidden rounded-4xl border border-border/30 bg-card py-6 text-card-foreground text-sm shadow-md outline-1 outline-border/60 outline-solid outline-offset-2 data-[size=sm]:gap-4 data-[size=sm]:py-4",
        className
      )}
      data-size={size}
      data-slot="card"
      {...props}
    />
  );
}
