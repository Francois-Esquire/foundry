import { artifact } from "@foundry/marbles";
import { z } from "zod";

export const repository = "OWNER/REPOSITORY";
export const baseBranch = "main";
export const maxAttempts = 3;
export const issueInput = z.object({ issue: z.number().int().positive() });
const sessionRef = z.object({
  id: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
});
export const issueSchema = z.object({
  body: z.string(),
  number: z.number(),
  state: z.enum(["OPEN", "CLOSED"]),
  title: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});
export const planSchema = z.object({
  approach: z.array(z.string()).min(1),
  checks: z.array(z.string()).min(1),
  questions: z.array(z.string()),
});
export const reviewSchema = z.object({
  blockers: z.array(z.string()),
  criteria: z.array(
    z.object({ criterion: z.string(), evidence: z.string(), met: z.boolean() })
  ),
  notes: z.array(z.string()),
});
export const recordSchema = z.object({
  acceptance: z.array(z.string()),
  attempts: z.number().int().nonnegative(),
  base: z.string(),
  change: z
    .object({ branch: z.string(), revision: z.string(), summary: z.string() })
    .optional(),
  decision: z
    .object({ approved: z.boolean(), note: z.string(), revision: z.string() })
    .optional(),
  events: z.array(
    z.object({
      at: z.string(),
      detail: z.string(),
      runId: z.string(),
      stage: z.string(),
    })
  ),
  issue: issueSchema,
  plan: planSchema.optional(),
  pullRequest: z
    .object({ number: z.number(), revision: z.string(), url: z.string() })
    .optional(),
  reviewer: sessionRef.optional(),
  status: z.enum([
    "triaged",
    "queued",
    "planned",
    "implementing",
    "implemented",
    "needs-changes",
    "verified",
    "approved",
    "declined",
    "pr-open",
    "merged",
    "closed",
    "blocked",
  ]),
  verification: z
    .object({
      review: reviewSchema,
      revision: z.string(),
      testsPassed: z.boolean(),
    })
    .optional(),
});
export type WorkRecord = z.infer<typeof recordSchema>;
export const workInput = z.object({ work: recordSchema });
export const journal = (issue: number) =>
  artifact({
    name: `Factory ${repository}#${issue}`,
    type: "application/json",
  });
export async function readRecord(
  issue: number
): Promise<WorkRecord | undefined> {
  const version = await journal(issue).latest();
  const text = await version?.text("record.json");
  return text ? recordSchema.parse(JSON.parse(text)) : undefined;
}
export async function requireRecord(issue: number): Promise<WorkRecord> {
  const record = await readRecord(issue);
  if (!record) {
    throw new Error("No work log exists. Run factory intake first.");
  }
  return record;
}
export function chronicle(record: WorkRecord): string {
  return [
    `# ${repository}#${record.issue.number}: ${record.issue.title}`,
    record.issue.url,
    `Status: ${record.status}`,
    `Original base: ${record.base}`,
    "## Acceptance criteria",
    ...record.acceptance.map((item) => `- ${item}`),
    "## History",
    ...record.events.map(
      (event) =>
        `### ${event.at} ${event.stage}\n\nRun: ${event.runId}\n\n${event.detail}`
    ),
  ].join("\n\n");
}
export async function recordEvent(
  record: WorkRecord,
  runId: string,
  stage: string,
  detail: string,
  files: Record<string, string> = {}
): Promise<WorkRecord> {
  const next = recordSchema.parse({
    ...record,
    events: [
      ...record.events,
      {
        at: new Date().toISOString(),
        detail,
        runId,
        stage,
      },
    ],
  });
  await journal(record.issue.number).write(
    {
      ...files,
      "chronicle.md": chronicle(next),
      "record.json": JSON.stringify(next, null, 2),
    },
    { replace: false }
  );
  return next;
}
export function newRecord(
  issue: z.infer<typeof issueSchema>,
  base: string
): WorkRecord {
  return {
    acceptance: [],
    attempts: 0,
    base,
    events: [],
    issue,
    status: "triaged",
  };
}
