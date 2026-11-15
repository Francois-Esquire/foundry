CREATE TABLE `marbles_agent_grants` (
	`grants` text NOT NULL,
	`scope` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marbles_deferred_approvals` (
	`approvals` text NOT NULL,
	`scope` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marbles_delivery_claims` (
	`owner_id` text,
	`owner_pid` integer,
	`scope` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marbles_harness_activities` (
	`key` text NOT NULL,
	`record` text NOT NULL,
	`revision` integer NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `marbles_identity_keys` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `marbles_provider_configurations` (
	`configuration` text NOT NULL,
	`revision` integer NOT NULL,
	`scope` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE INDEX `marbles_provider_configurations_revision` ON `marbles_provider_configurations` (`revision`);