CREATE TABLE `marbles_resource_workspaces` (
	`associated_at` text NOT NULL,
	`kind` text NOT NULL,
	`owner` text NOT NULL,
	`resource_id` text NOT NULL,
	`workspace` text NOT NULL,
	PRIMARY KEY(`owner`, `kind`, `resource_id`, `workspace`)
);
--> statement-breakpoint
CREATE INDEX `marbles_resource_workspaces_kind_workspace` ON `marbles_resource_workspaces` (`kind`,`workspace`);