import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type {
  Occurrence,
  OccurrenceId,
  OccurrenceState,
  Schedule,
  ScheduleCursor,
  ScheduleId,
} from "../domain";

export const schedulingSchedules = sqliteTable(
  "scheduling_schedules",
  {
    body: text("body", { mode: "json" }).$type<Schedule>().notNull(),
    id: text("id").$type<ScheduleId>().notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.id] })]
);

export const schedulingCursors = sqliteTable(
  "scheduling_cursors",
  {
    body: text("body", { mode: "json" }).$type<ScheduleCursor>().notNull(),
    nextDueAt: integer("next_due_at"),
    scheduleId: text("schedule_id").$type<ScheduleId>().notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.scheduleId] }),
    index("scheduling_cursors_scope_next_due").on(table.scope, table.nextDueAt),
  ]
);

export const schedulingOccurrences = sqliteTable(
  "scheduling_occurrences",
  {
    body: text("body", { mode: "json" }).$type<Occurrence>().notNull(),
    id: text("id").$type<OccurrenceId>().notNull(),
    scheduledFor: integer("scheduled_for").notNull(),
    scheduleId: text("schedule_id").$type<ScheduleId>().notNull(),
    scope: text("scope").notNull(),
    state: text("state").$type<OccurrenceState["kind"]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("scheduling_occurrences_scope_schedule_state").on(
      table.scope,
      table.scheduleId,
      table.state
    ),
  ]
);

export const schedulingTables = [
  schedulingSchedules,
  schedulingCursors,
  schedulingOccurrences,
];
