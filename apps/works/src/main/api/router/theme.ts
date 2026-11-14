import { z } from "zod";
import { THEME_MODES } from "~/shared/theme";
import { base, requires } from "../context";

const theme = base.use(requires(["theme"]));

/** Main owns the theme; the renderer's selector reads and sets it here. */
export const themeRouter = {
  /** First run: offer the mode the renderer kept before main owned it. */
  adopt: theme
    .input(z.object({ mode: z.enum(THEME_MODES).nullable() }))
    .handler(({ context, input }) => context.theme.adopt(input.mode)),
  set: theme
    .input(z.object({ mode: z.enum(THEME_MODES) }))
    .handler(({ context, input }) => context.theme.set(input.mode)),
  /** The current snapshot, then each change. */
  watch: theme.handler(({ context, signal }) => context.theme.watch(signal)),
};
