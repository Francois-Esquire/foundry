CREATE TABLE `marbles_workflow_runs` (
	`ledger` text NOT NULL,
	`literals` text NOT NULL,
	`owner_id` text,
	`owner_pid` integer,
	`run_id` text NOT NULL,
	`scope` text NOT NULL,
	`session_id` text,
	PRIMARY KEY(`scope`, `run_id`)
);
--> statement-breakpoint
CREATE INDEX `marbles_workflow_runs_scope_owner` ON `marbles_workflow_runs` (`scope`,`owner_id`);