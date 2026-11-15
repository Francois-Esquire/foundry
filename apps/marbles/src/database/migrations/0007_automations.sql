CREATE TABLE `marbles_automations` (
	`agent_id` text NOT NULL,
	`at` text NOT NULL,
	`created_at` text NOT NULL,
	`enabled` integer NOT NULL,
	`id` text NOT NULL,
	`input` text,
	`key` text NOT NULL,
	`owner_definition` text NOT NULL,
	`owner_path` text NOT NULL,
	`owner_run_id` text NOT NULL,
	`scope` text NOT NULL,
	`session_id` text NOT NULL,
	`source` text,
	`version` integer NOT NULL,
	`workflow` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
