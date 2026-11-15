CREATE TABLE `marbles_execution_gaps` (
	`gap_scope` text NOT NULL,
	`removed` integer NOT NULL,
	`scope` text NOT NULL,
	`through` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`scope`, `gap_scope`)
);
--> statement-breakpoint
CREATE TABLE `marbles_execution_observations` (
	`observation` text NOT NULL,
	`observation_id` text NOT NULL,
	`position` integer NOT NULL,
	`run_id` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `run_id`, `observation_id`)
);
--> statement-breakpoint
CREATE INDEX `marbles_execution_observations_scope_run_position` ON `marbles_execution_observations` (`scope`,`run_id`,`position`);--> statement-breakpoint
CREATE TABLE `marbles_executions` (
	`correlation` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`id` text NOT NULL,
	`input` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`owner_pid` integer NOT NULL,
	`progress` text,
	`queue` text NOT NULL,
	`queued_at` text NOT NULL,
	`revision` integer NOT NULL,
	`scope` text NOT NULL,
	`sequence` integer NOT NULL,
	`settled_at` text,
	`source` text,
	`started_at` text,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `marbles_executions_scope_source` ON `marbles_executions` (`scope`,`name`,`source`);