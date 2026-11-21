import { z } from "zod";
import { THEME_MODES } from "~/shared/theme";
import { base, requires } from "../context";

const theme = base.use(requires(["theme"]));

export const themeRouter = {
  adopt: theme
    .input(z.object({ mode: z.enum(THEME_MODES).nullable() }))
    .handler(({ context, input }) => context.theme.adopt(input.mode)),
  set: theme
    .input(z.object({ mode: z.enum(THEME_MODES) }))
    .handler(({ context, input }) => context.theme.set(input.mode)),
  watch: theme.handler(({ context, signal }) => context.theme.watch(signal)),
};
