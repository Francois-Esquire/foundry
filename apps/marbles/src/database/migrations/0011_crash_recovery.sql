CREATE TABLE `marbles_recoveries` (
	`at` text NOT NULL,
	`scope` text PRIMARY KEY NOT NULL,
	`steps` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sandbox_containers` ADD `holder` text;--> statement-breakpoint
ALTER TABLE `marbles_delivery_claims` ADD `owner_started` text;--> statement-breakpoint
ALTER TABLE `marbles_executions` ADD `owner_started` text;--> statement-breakpoint
ALTER TABLE `marbles_schedule_ticks` ADD `owner_started` text;--> statement-breakpoint
ALTER TABLE `marbles_workflow_runs` ADD `owner_started` text;