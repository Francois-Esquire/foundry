CREATE TABLE `marbles_change_logs` (
	`compacted` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`scope` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marbles_changes` (
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`position` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`run_id` text,
	`scope` text NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	PRIMARY KEY(`scope`, `position`)
);
--> statement-breakpoint
CREATE INDEX `marbles_changes_scope_source_position` ON `marbles_changes` (`scope`,`source`,`position`);--> statement-breakpoint
CREATE TABLE `marbles_observers` (
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`missed_from` integer,
	`missed_through` integer,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`retry_at` integer,
	`scope` text NOT NULL,
	`seen_at` integer NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`scope`, `source`, `name`)
);
--> statement-breakpoint
DROP TABLE `marbles_task_change_deliveries`;--> statement-breakpoint
DROP TABLE `marbles_task_changes`;