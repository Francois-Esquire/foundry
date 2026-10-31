import { z } from "zod";

import type { DispatchOptions } from "~/model/connection";

/** What an agent dispatch takes, as MCP validates it; the type lives in `model/connection.ts`. */

export const dispatchSchema = z.object({
  agent: z.string().trim().min(1).optional(),
  compaction: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  instructions: z.string().trim().min(1).optional(),
  maxTurns: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "Maximum model/tool steps, not a target. Supported by network models and local Claude Code, not local Codex/Pi."
    ),
  model: z.string().min(1).optional(),
  prompt: z.string().trim().min(1),
  provider: z.string().min(1).optional(),
  session: z
    .object({
      id: z.string().min(1),
      model: z.string().optional(),
      provider: z.string().optional(),
    })
    .optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
}) satisfies z.ZodType<DispatchOptions>;
