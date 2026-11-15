CREATE TABLE `marbles_monitor_states` (
	`key` text NOT NULL,
	`observed` text NOT NULL,
	`pending` text,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `marbles_schedule_ticks` (
	`key` text NOT NULL,
	`kind` text,
	`label` text,
	`last_finish` text,
	`last_start` text,
	`last_status` text,
	`next_due` text,
	`owner_id` text,
	`owner_pid` integer,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
