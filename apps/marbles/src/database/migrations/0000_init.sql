CREATE TABLE `marbles_workspaces` (
	`config` text,
	`first_seen` text NOT NULL,
	`hosted` integer DEFAULT false NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` text NOT NULL,
	`root` text NOT NULL
);
