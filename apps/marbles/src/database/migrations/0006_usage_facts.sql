CREATE TABLE `marbles_usage_facts` (
	`fact` text NOT NULL,
	`lost` text,
	`revision` integer NOT NULL,
	`run_id` text,
	`scope` text NOT NULL,
	`turn_id` text NOT NULL,
	PRIMARY KEY(`scope`, `turn_id`)
);
--> statement-breakpoint
CREATE INDEX `marbles_usage_facts_scope_revision` ON `marbles_usage_facts` (`scope`,`revision`);