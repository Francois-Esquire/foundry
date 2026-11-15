CREATE TABLE `task_dependencies` (
	`depends_on_id` text NOT NULL,
	`position` integer NOT NULL,
	`scope` text NOT NULL,
	`task_id` text NOT NULL,
	PRIMARY KEY(`scope`, `task_id`, `depends_on_id`)
);
--> statement-breakpoint
CREATE INDEX `task_dependencies_scope_position` ON `task_dependencies` (`scope`,`position`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`created_at` text NOT NULL,
	`description` text,
	`id` text NOT NULL,
	`metadata` text NOT NULL,
	`parent_id` text,
	`position` integer NOT NULL,
	`scope` text NOT NULL,
	`settled_at` text,
	`status` text NOT NULL,
	`tags` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `tasks_scope_position` ON `tasks` (`scope`,`position`);--> statement-breakpoint
CREATE TABLE `marbles_task_change_deliveries` (
	`change_id` text NOT NULL,
	`handler` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `change_id`, `handler`)
);
--> statement-breakpoint
CREATE TABLE `marbles_task_changes` (
	`id` text NOT NULL,
	`payload` text NOT NULL,
	`position` integer NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE INDEX `marbles_task_changes_scope_position` ON `marbles_task_changes` (`scope`,`position`);